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
                    '<body><header>Header</header><main><div class="nested"><div class="deeply-nested">Deep content</div></div></main><footer>Footer</footer></body>',
                outerHTMLWithoutText:
                    '<body><header></header><main><div class="nested"><div class="deeply-nested"></div></div></main><footer></footer></body>',
                textContent: "Header  Deep content  Footer",
                content: undefined,
                domPath: "html > body",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                },
                textBBoxes: [],
            },
            {
                id: 11,
                parentId: 9,
                nodeName: "header",
                outerHTML: "<header>Header</header>",
                outerHTMLWithoutText: "<header></header>",
                textContent: "Header",
                content: undefined,
                domPath: "html > body > header",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: 50,
                    left: expect.any(Number),
                },
                textBBoxes: [],
            },
            {
                id: 12,
                parentId: 11,
                nodeName: "#text",
                outerHTML: "Header",
                outerHTMLWithoutText: "Header",
                textContent: "Header",
                content: undefined,
                domPath: "html > body > header > :nth-text-node(1)",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                },
                textBBoxes: [
                    {
                        bottom: 18,
                        left: 0,
                        right: 46.1875,
                        top: 0,
                    },
                ],
            },
            {
                id: 14,
                parentId: 9,
                nodeName: "main",
                outerHTML: '<main><div class="nested"><div class="deeply-nested">Deep content</div></div></main>',
                outerHTMLWithoutText: '<main><div class="nested"><div class="deeply-nested"></div></div></main>',
                textContent: "Deep content",
                content: undefined,
                domPath: "html > body > main",
                bbox: {
                    top: 50,
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                },
                textBBoxes: [],
            },
            {
                id: 16,
                parentId: 14,
                nodeName: "div",
                outerHTML: '<div class="nested"><div class="deeply-nested">Deep content</div></div>',
                outerHTMLWithoutText: '<div class="nested"><div class="deeply-nested"></div></div>',
                textContent: "Deep content",
                content: undefined,
                domPath: "html > body > main > div.nested",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                },
                textBBoxes: [],
            },
            {
                id: 17,
                parentId: 16,
                nodeName: "::after",
                outerHTML: '<div class="nested"><div class="deeply-nested">Deep content</div></div>',
                outerHTMLWithoutText: '<div class="nested"><div class="deeply-nested"></div></div>',
                textContent: "Deep content",
                content: '"Hello world!"',
                domPath: "html > body > main > div.nested::after",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: 118,
                    left: expect.any(Number),
                },
                textBBoxes: [
                    {
                        bottom: 118,
                        left: expect.any(Number),
                        right: expect.any(Number),
                        top: expect.any(Number),
                    },
                ],
            },
            {
                id: 19,
                parentId: 16,
                nodeName: "div",
                outerHTML: '<div class="deeply-nested">Deep content</div>',
                outerHTMLWithoutText: '<div class="deeply-nested"></div>',
                textContent: "Deep content",
                content: undefined,
                domPath: "html > body > main > div.nested > div.deeply-nested",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                },
                textBBoxes: [],
            },
            {
                id: 20,
                parentId: 19,
                nodeName: "#text",
                outerHTML: "Deep content",
                outerHTMLWithoutText: "Deep content",
                textContent: "Deep content",
                content: undefined,
                domPath: "html > body > main > div.nested > div.deeply-nested > :nth-text-node(1)",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                },
                textBBoxes: [
                    {
                        bottom: expect.any(Number),
                        left: 30,
                        right: expect.any(Number),
                        top: 80,
                    },
                ],
            },
            {
                id: 24,
                parentId: 9,
                nodeName: "footer",
                outerHTML: "<footer>Footer</footer>",
                outerHTMLWithoutText: "<footer></footer>",
                textContent: "Footer",
                content: undefined,
                domPath: "html > body > footer",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                },
                textBBoxes: [],
            },
            {
                id: 25,
                parentId: 24,
                nodeName: "#text",
                outerHTML: "Footer",
                outerHTMLWithoutText: "Footer",
                textContent: "Footer",
                content: undefined,
                domPath: "html > body > footer > :nth-text-node(1)",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                },
                textBBoxes: [
                    {
                        bottom: expect.any(Number),
                        left: 0,
                        right: expect.any(Number),
                        top: expect.any(Number),
                    },
                ],
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
                outerHTML: '<body class="test-body"><div id="test-element">Test</div></body>',
                outerHTMLWithoutText: '<body class="test-body"><div id="test-element"></div></body>',
                textContent: "Test",
                content: undefined,
                domPath: "html > body.test-body",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                },
                textBBoxes: [],
            },
            {
                id: 7,
                parentId: 5,
                nodeName: "div",
                outerHTML: '<div id="test-element">Test</div>',
                outerHTMLWithoutText: '<div id="test-element"></div>',
                textContent: "Test",
                content: undefined,
                domPath: "html > body.test-body > #test-element",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                },
                textBBoxes: [],
            },
            {
                id: 8,
                parentId: 7,
                nodeName: "#text",
                outerHTML: "Test",
                outerHTMLWithoutText: "Test",
                textContent: "Test",
                content: undefined,
                domPath: "html > body.test-body > #test-element > :nth-text-node(1)",
                bbox: {
                    top: expect.any(Number),
                    right: expect.any(Number),
                    bottom: expect.any(Number),
                    left: expect.any(Number),
                },
                textBBoxes: [
                    {
                        bottom: expect.any(Number),
                        left: 8,
                        right: expect.any(Number),
                        top: 8,
                    },
                ],
            },
        ]);
    });
    it("all elements should be present, even thouse not in the layout", async () => {
        page = await browser.newPage();
        await page.goto(`http://localhost:${port}/page-layout.html`);
        await page.setJavaScriptEnabled(false);

        const result = await extractFeaturesFromHTML(page);
        expect(result).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    outerHTML: expect.stringContaining('<div id="to-be-hidden" style="display: none;"></div>'),
                    bbox: {
                        top: -1,
                        right: -2,
                        bottom: -2,
                        left: -1,
                    },
                }),
            ])
        );
    });

    it("missing layout elements", async () => {
        page = await browser.newPage();
        await page.goto(`http://localhost:${port}/page-darwinhub.pl.html`);
        await page.setJavaScriptEnabled(false);
        await page.screenshot({ fullPage: true });
        const result = await extractFeaturesFromHTML(page);
        const elements = result.filter((el) => el.outerHTML === '<div class="content_20_line"></div>');
        const parents = result.filter((el) => elements.some((e) => e.parentId === el.id));
        expect(elements.length).toEqual(2);
        expect(parents.length).toEqual(2);
        expect(elements[0].bbox).not.toEqual(elements[1].bbox);
    });

    it("css selectors", async () => {
        page = await browser.newPage();
        await page.goto(`http://localhost:${port}/page-css-selectors.html`);
        const result = await extractFeaturesFromHTML(page);
        expect(result.map((r) => r.domPath)).toEqual([
            "html > body.body",
            "html > body.body > x\\:t",
            "html > body.body > x\\:t > :nth-text-node(1)",
            "html > body.body > #box1\\:\\:id",
            "html > body.body > #box1\\:\\:id > :nth-text-node(1)",
            "html > body.body > div.lg\\:hidden",
            "html > body.body > div.lg\\:hidden > :nth-text-node(1)",
        ]);
    });
});
