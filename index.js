const fs = require('fs');                
const { promisify } = require('util');
const url = require('url');
const beautify = require('js-beautify').js;
const crypto = require('crypto');

const puppeteer = require('puppeteer');  
const { harFromMessages } = require('chrome-har');

const events = []; // HAR events that will be exported
const addResponseBodyPromises = []; // response fetch promises

const targetUrl = process.argv[2];
const scope = process.argv[3] ? process.argv[3].split(',') : false;

if (!targetUrl) {
    console.log('missing url argument');
    process.exit();
}

if (scope) {
    console.log('SCOPE ENABLED: Only download responses of scoped (sub)domains - ', scope);
}


function sha1(value) {
    const shasum = crypto.createHash('sha1');
    shasum.update(value);
    return shasum.digest('hex');
}

function shorten(value) {
    if (value.length < 30)
        return value;

    return value.substr(0, 40) + '...';
}

function inScope(url) {
    if (scope == false)
        return true;

    if (url.match('(' + scope.join('|') + ')'))
        return true;

    return false;
}

const myURL = new URL(targetUrl);
const host = myURL.host;
const hash = sha1(myURL.pathname);
const filename = `${host}.${hash}.har`;

// event types to observe
const observe = [
  'Page.loadEventFired',
  'Page.domContentEventFired',
  'Page.frameStartedLoading',
  'Page.frameAttached',
  'Network.requestWillBeSent',
  'Network.requestServedFromCache',
  'Network.dataReceived',
  'Network.responseReceived',
  'Network.resourceChangedPriority',
  'Network.loadingFinished',
  'Network.loadingFailed',
];

(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    const client = await page.target().createCDPSession();
    await client.send('Page.enable');
    await client.send('Network.enable');

    observe.forEach(method => {
        client.on(method, params => {

            const harEvent = { method, params };
            events.push(harEvent);

            if (method === 'Network.responseReceived') {
                const response = harEvent.params.response;
                const requestId = harEvent.params.requestId;

                if (response.status !== 204 &&
                    response.headers.location == null &&
                    inScope(response.url) &&
                    !response.mimeType.includes('image') &&
                    !response.mimeType.includes('audio') &&
                    !response.mimeType.includes('font') &&
                    !response.mimeType.includes('binary') &&
                    !response.mimeType.includes('video')
                ) {
                    addResponseBodyPromises.push(async function() { 
                        try {

                            const responseBody = await client.send( 'Network.getResponseBody', { requestId });
                            let body = responseBody.body;

                            // make pretty
                            let pretty = false;
                            if (response.mimeType.includes('json')) {
                                body = JSON.stringify(JSON.parse(body), null, 4);
                                pretty = true;
                            }

                            if (response.mimeType.includes('javascript')) {
                                body = beautify(body, { indent_size: 4, space_in_empty_paren: true });
                                pretty = true;
                            }

                            console.log('ADD', shorten(params.response.url), response.status, response.mimeType, { pretty });

                            harEvent.params.response = {
                                ...response,
                                body: new Buffer.from(
                                    body,
                                    responseBody.base64Encoded ? 'base64' : undefined,
                                ).toString(),
                            };
                            //console.log('RESPONSE', responseBody);

                        } catch(e) {
                            console.log('FAIL', params.response.url, response.status, response.mimeType, e);
                        }

                    });

                } else {
                    console.log('IGNORE', shorten(params.response.url), response.status, response.mimeType);
                }
            }
        });
    });

    await page.goto(targetUrl, { waitUntil: 'networkidle2' });
    
    //page.click('#n-help > a');

    // wait for the response body to be added to all of the
    // Network.responseReceived events before passing them to chrome-har to be
    // converted into a HAR.
    await Promise.all(addResponseBodyPromises.map(async (fetchResponse) => {
        await fetchResponse();
    }));

    await browser.close();
    const har = harFromMessages(events, { includeResourcesFromDiskCache: true, includeTextFromResponseBody: true });
    await promisify(fs.writeFile)(filename, JSON.stringify(har));

})();
