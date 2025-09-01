import puppeteer, { Browser, Page } from "puppeteer";
import { extractFeaturesFromHTML } from "@/index.mjs";
import { app } from "./lib/server.js";
import { Server } from "http";
import getPort from "get-port";

describe("extractFeaturesFromHTML", () => {
    let browser: Browser;
    let page: Page;
    let server: Server;
    let port: number;

    beforeAll(async () => {
        browser = await puppeteer.launch({ headless: true });
        port = await getPort();
        await new Promise<void>((resolve) => {
            server = app.listen(port, () => resolve());
        });
    });

    afterAll(async () => {
        if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
        }
        await browser.close();
    });

    beforeEach(async () => {});

    afterEach(async () => {});

    it("should extract DOM elements from a simple page with known elements", async () => {
        page = await browser.newPage();
        await page.goto(`http://localhost:${port}/page-nested.html`);

        const result = await extractFeaturesFromHTML(page);
        expect(result).toEqual([
            {
                id: 9,
                parentId: undefined,
                nodeName: "body",
                outerHTML:
                    "<body><header>Header</header><main><div class=\"nested\"><div class=\"deeply-nested\">Deep content</div></div></main><footer>Footer</footer></body>",
                outerHTMLWithoutText:
                    "<body><header></header><main><div class=\"nested\"><div class=\"deeply-nested\"></div></div></main><footer></footer></body>",
                textContent: "Header  Deep content  Footer",
                content: undefined,
                domPath: "body",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                    width: expect.any(Number),
                    height: expect.any(Number),
                    x: expect.any(Number),
                    y: expect.any(Number),
                },
            },
            {
                id: 11,
                parentId: 9,
                nodeName: "header",
                outerHTML: "<header>Header</header>",
                outerHTMLWithoutText: "<header></header>",
                textContent: "Header",
                content: undefined,
                domPath: "body > header",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: 50,
                    left: expect.any(Number),
                    width: expect.any(Number),
                    height: 50,
                    x: expect.any(Number),
                    y: expect.any(Number),
                },
            },
            {
                id: 12,
                parentId: 11,
                nodeName: "#text",
                outerHTML: "Header",
                outerHTMLWithoutText: "Header",
                textContent: "Header",
                content: undefined,
                domPath: "body > header > #text:nth-of-type(1)",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                    width: expect.any(Number),
                    height: expect.any(Number),
                    x: expect.any(Number),
                    y: expect.any(Number),
                },
            },
            {
                id: 14,
                parentId: 9,
                nodeName: "main",
                outerHTML: "<main><div class=\"nested\"><div class=\"deeply-nested\">Deep content</div></div></main>",
                outerHTMLWithoutText: "<main><div class=\"nested\"><div class=\"deeply-nested\"></div></div></main>",
                textContent: "Deep content",
                content: undefined,
                domPath: "body > main",
                bbox: {
                    top: 50,
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                    width: expect.any(Number),
                    height: expect.any(Number),
                    x: expect.any(Number),
                    y: 50,
                },
            },
            {
                id: 16,
                parentId: 14,
                nodeName: "div",
                outerHTML: "<div class=\"nested\"><div class=\"deeply-nested\">Deep content</div></div>",
                outerHTMLWithoutText: "<div class=\"nested\"><div class=\"deeply-nested\"></div></div>",
                textContent: "Deep content",
                content: undefined,
                domPath: "body > main > div.nested",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                    width: expect.any(Number),
                    height: expect.any(Number),
                    x: expect.any(Number),
                    y: expect.any(Number),
                },
            },
            {
                id: 17,
                parentId: 16,
                nodeName: "::after",
                outerHTML: "<div class=\"nested\"><div class=\"deeply-nested\">Deep content</div></div>",
                outerHTMLWithoutText: "<div class=\"nested\"><div class=\"deeply-nested\"></div></div>",
                textContent: "Deep content",
                content: "\"Hello world!\"",
                domPath: "body > main > div.nested",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                    width: expect.any(Number),
                    height: 20,
                    x: expect.any(Number),
                    y: expect.any(Number),
                },
            },
            {
                id: 19,
                parentId: 16,
                nodeName: "div",
                outerHTML: "<div class=\"deeply-nested\">Deep content</div>",
                outerHTMLWithoutText: "<div class=\"deeply-nested\"></div>",
                textContent: "Deep content",
                content: undefined,
                domPath: "body > main > div.nested > div.deeply-nested",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                    width: expect.any(Number),
                    height: expect.any(Number),
                    x: expect.any(Number),
                    y: expect.any(Number),
                },
            },
            {
                id: 20,
                parentId: 19,
                nodeName: "#text",
                outerHTML: "Deep content",
                outerHTMLWithoutText: "Deep content",
                textContent: "Deep content",
                content: undefined,
                domPath: "body > main > div.nested > div.deeply-nested > #text:nth-of-type(1)",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                    width: expect.any(Number),
                    height: expect.any(Number),
                    x: expect.any(Number),
                    y: expect.any(Number),
                },
            },
            {
                id: 24,
                parentId: 9,
                nodeName: "footer",
                outerHTML: "<footer>Footer</footer>",
                outerHTMLWithoutText: "<footer></footer>",
                textContent: "Footer",
                content: undefined,
                domPath: "body > footer",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                    width: expect.any(Number),
                    height: expect.any(Number),
                    x: expect.any(Number),
                    y: expect.any(Number),
                },
            },
            {
                id: 25,
                parentId: 24,
                nodeName: "#text",
                outerHTML: "Footer",
                outerHTMLWithoutText: "Footer",
                textContent: "Footer",
                content: undefined,
                domPath: "body > footer > #text:nth-of-type(1)",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                    width: expect.any(Number),
                    height: expect.any(Number),
                    x: expect.any(Number),
                    y: expect.any(Number),
                },
            },
        ]);
    });

    it("should have correct result structure for each element", async () => {
        const testHtml = `
            <!DOCTYPE html>
            <html>
            <head></head>
            <body class="test-body">
                <div id="test-element">Test</div>
            </body>
            </html>
        `;

        page = await browser.newPage();
        await page.goto("data:text/html," + encodeURIComponent(testHtml));

        const result = await extractFeaturesFromHTML(page);
        expect(result).toEqual([
            {
                id: 5,
                parentId: undefined,
                nodeName: "body",
                outerHTML: "<body class=\"test-body\"><div id=\"test-element\">Test</div></body>",
                outerHTMLWithoutText: "<body class=\"test-body\"><div id=\"test-element\"></div></body>",
                textContent: "Test",
                content: undefined,
                domPath: "body.test-body",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                    width: expect.any(Number),
                    height: expect.any(Number),
                    x: expect.any(Number),
                    y: expect.any(Number),
                },
            },
            {
                id: 7,
                parentId: 5,
                nodeName: "div",
                outerHTML: "<div id=\"test-element\">Test</div>",
                outerHTMLWithoutText: "<div id=\"test-element\"></div>",
                textContent: "Test",
                content: undefined,
                domPath: "body.test-body > #test-element",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                    width: expect.any(Number),
                    height: expect.any(Number),
                    x: expect.any(Number),
                    y: expect.any(Number),
                },
            },
            {
                id: 8,
                parentId: 7,
                nodeName: "#text",
                outerHTML: "Test",
                outerHTMLWithoutText: "Test",
                textContent: "Test",
                content: undefined,
                domPath: "body.test-body > #test-element > #text:nth-of-type(1)",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                    width: expect.any(Number),
                    height: expect.any(Number),
                    x: expect.any(Number),
                    y: expect.any(Number),
                },
            },
        ]);
    });
});
