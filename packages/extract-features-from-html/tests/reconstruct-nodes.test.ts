import puppeteer, { Browser, Page } from "puppeteer";
import { app } from "./lib/server.js";
import { Server } from "http";
import getPort from "get-port";
import { reconstructOuterHTML } from "@/lib/reconstruct-outerhtml.mjs";
import { injectGenerateUniqueSelectors } from "@/lib/generate-unique-selectors.mjs";
import { DebugDecorator } from "@watchero/debug-decorator";

describe("reconstructNodes", () => {
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

    it("should properly reconstruct outerHTML basic", async () => {
        page = await browser.newPage();
        const debugDecorator = new DebugDecorator();
        await debugDecorator.decorate({ page });
        await page.goto(`http://localhost:${port}/page.html`);
        await page.evaluate(injectGenerateUniqueSelectors);
        await page.evaluate(() => window.generateUniqueSelectors());

        const client = await page.createCDPSession();
        const { root } = await client.send("DOM.getDocument", {
            depth: -1, // Get the full tree
            pierce: true, // Pierce through shadow roots
        });
        const result = reconstructOuterHTML(root);

        // let's skip some of the first elements as they are too bulky
        expect(result.map((item) => item.outerHTML).slice(6)).toEqual([
            '<body class="body"><div id="box1">Box 1</div><div id="box2">Box 2<span>Text</span>Text</div><script></script></body>',
            '<div id="box1">Box 1</div>',
            "Box 1",
            '<div id="box2">Box 2<span>Text</span>Text</div>',
            "Box 2",
            "<span>Text</span>",
            "Text",
            "Text",
            "",
            "",
            "<script></script>",
            `
        const duplicate = document.getElementById("box1").cloneNode(true);
        document.documentElement.appendChild(duplicate);
    `,
            "<div id=\"box1\">Box 1</div>",
            "Box 1",
        ]);
        expect(result.map((item) => item.outerHTMLWithoutText)).toEqual([
            "",
            "",
            '<html><head><style></style></head><body class="body"><div id="box1"></div><div id="box2"><span></span></div><script></script></body><div id="box1"></div></html>',
            "<head><style></style></head>",
            "<style></style>",
            `
        body { margin: 0; padding: 0; }
        #box1 { position: absolute; left: 10px; top: 10px; width: 100px; height: 100px; background: red; }
        #box2 { position: absolute; left: 150px; top: 50px; width: 80px; height: 80px; background: blue; }
        #box2::after { content: "Box 2 After"; }
    `,
            '<body class="body"><div id="box1"></div><div id="box2"><span></span></div><script></script></body>',
            '<div id="box1"></div>',
            "Box 1",
            '<div id="box2"><span></span></div>',
            "Box 2",
            "<span></span>",
            "Text",
            "Text",
            "",
            "",
            "<script></script>",
            `
        const duplicate = document.getElementById("box1").cloneNode(true);
        document.documentElement.appendChild(duplicate);
    `,
            "<div id=\"box1\"></div>",
            "Box 1",
        ]);

        expect(result.map((item) => item.domPath)).toEqual([
            undefined,
            undefined,
            "html",
            "html > head",
            "html > head > style",
            "html > head > style > :nth-text-node(1)", // text of the style
            "html > body.body",
            "html > body.body > #box1",
            "html > body.body > #box1 > :nth-text-node(1)",
            "html > body.body > #box2",
            "html > body.body > #box2 > :nth-text-node(1)",
            "html > body.body > #box2 > span",
            "html > body.body > #box2 > span > :nth-text-node(1)",
            "html > body.body > #box2 > :nth-text-node(2)",
            "html > body.body > #box2 > :nth-comment-node(1)",
            "html > body.body > #box2 > :nth-comment-node(2)",
            "html > body.body > script",
            "html > body.body > script > :nth-text-node(1)",
            "html > #box1",
            "html > #box1 > :nth-text-node(1)",
        ]);

        //console.log(result.map(item => item.outerHTML));
    });

    it("should properly reconstruct outerHTML and skip href and src attributes", async () => {
        page = await browser.newPage();
        await page.goto(`http://localhost:${port}/page-attributes.html`);
        await page.evaluate(injectGenerateUniqueSelectors);
        await page.evaluate(() => window.generateUniqueSelectors());

        const client = await page.createCDPSession();
        const { root } = await client.send("DOM.getDocument", {
            depth: -1, // Get the full tree
            pierce: true, // Pierce through shadow roots
        });
        const result = reconstructOuterHTML(root);

        // let's skip some of the first elements as they are too bulky
        expect(result.map((item) => item.outerHTML)).toEqual([
            "",
            "",
            '<html><head></head><body class="body"><a href="https://google.com/"><img src="https://google.com/" alt="Image"></img></a></body></html>',
            "<head></head>",
            '<body class="body"><a href="https://google.com/"><img src="https://google.com/" alt="Image"></img></a></body>',
            '<a href="https://google.com/"><img src="https://google.com/" alt="Image"></img></a>',
            '<img src="https://google.com/" alt="Image"></img>',
        ]);
        expect(result.map((item) => item.outerHTMLWithoutText)).toEqual([
            "",
            "",
            '<html><head></head><body class="body"><a href=""><img src="" alt=""></img></a></body></html>',
            "<head></head>",
            '<body class="body"><a href=""><img src="" alt=""></img></a></body>',
            '<a href=""><img src="" alt=""></img></a>',
            '<img src="" alt=""></img>',
        ]);
        expect(result.map((item) => item.domPath)).toEqual([
            undefined,
            undefined,
            "html",
            "html > head",
            "html > body.body",
            "html > body.body > a[href=\"https\\:\\/\\/google\\.com\\/\"]",
            "html > body.body > a[href=\"https\\:\\/\\/google\\.com\\/\"] > img[src=\"https\\:\\/\\/google\\.com\\/\"]",
        ]);

        //console.log(result.map(item => item.outerHTML));
    });

    it("should properly reconstruct outerHTML with stripping data-fpo and data-wpmeteor attributes", async () => {
        page = await browser.newPage();
        await page.goto(`http://localhost:${port}/page-cleanup.html`);
        await page.evaluate(injectGenerateUniqueSelectors);
        await page.evaluate(() => window.generateUniqueSelectors());

        const client = await page.createCDPSession();
        const { root } = await client.send("DOM.getDocument", {
            depth: -1, // Get the full tree
            pierce: true, // Pierce through shadow roots
        });
        const result = reconstructOuterHTML(root);

        // let's skip some of the first elements as they are too bulky
        expect(result.map((item) => item.outerHTML)).toEqual([
            "",
            "",
            '<html><head></head><body class="body"><img src="/images/transparent-1x1.png" alt="Image"></img></body></html>',
            "<head></head>",
            '<body class="body"><img src="/images/transparent-1x1.png" alt="Image"></img></body>',
            '<img src="/images/transparent-1x1.png" alt="Image"></img>',
        ]);
        expect(result.map((item) => item.outerHTMLWithoutText)).toEqual([
            "",
            "",
            '<html><head></head><body class="body"><img src="" alt=""></img></body></html>',
            "<head></head>",
            '<body class="body"><img src="" alt=""></img></body>',
            '<img src="" alt=""></img>',
        ]);
        expect(result.map((item) => item.domPath)).toEqual([
            undefined,
            undefined,
            "html",
            "html > head",
            "html > body.body",
            "html > body.body > #fpo1",
        ]);

        //console.log(result.map(item => item.outerHTML));
    });
});
