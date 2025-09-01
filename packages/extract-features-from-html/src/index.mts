import { Page, Protocol } from "puppeteer";
import { CustomError } from "@watchero/custom-error";
import { reconstructOuterHTML } from "./lib/reconstruct-outerhtml.mjs";
import { injectGenerateUniqueSelectors } from "./lib/generate-unique-selectors.mjs";
import { HTMLElementFeature } from "@watchero/types";

const computedStyles = ["content"];

export async function extractFeaturesFromHTML(page: Page, _magicRatio = 0.5): Promise<HTMLElementFeature[]> {
    await page.evaluate(injectGenerateUniqueSelectors);
    await page.evaluate(() => window.generateUniqueSelectors());

    const client = await page.createCDPSession();

    // Capture a snapshot of the DOM.
    const snapshot: Protocol.DOMSnapshot.CaptureSnapshotResponse = await client.send("DOMSnapshot.captureSnapshot", {
        computedStyles, // You can list CSS property names if needed.
        includeDOMRects: true,
    });

    // Get the entire document with all nodes
    const { root } = await client.send("DOM.getDocument", {
        depth: -1, // Get the full tree
        pierce: true, // Pierce through shadow roots
    });

    const reconstructedNodes = reconstructOuterHTML(root);

    const document = snapshot.documents[0];
    const { nodes, layout } = document;
    const { nodeName, nodeType, nodeValue, backendNodeId, parentIndex } = nodes;

    if (!nodeName) {
        throw new CustomError("Invalid snapshot data structure.");
    }

    if (!nodeType) {
        throw new CustomError("Invalid snapshot data structure.");
    }

    if (!backendNodeId) {
        throw new CustomError("Invalid snapshot data structure.");
    }

    if (!parentIndex) {
        throw new CustomError("Invalid layout data structure.");
    }

    // Find the index of the <body> element.
    let bodyIndex: number | null = null;
    for (let i = 0; i < nodeName.length; i++) {
        if (snapshot.strings[nodeName[i]].toLowerCase() === "body") {
            bodyIndex = i;
            break;
        }
    }

    if (bodyIndex === null) {
        throw new CustomError("No <body> element found in snapshot.");
    }

    // Helper: determine if a given node (by index) is a descendant of <body>
    function isDescendantOfBody(index: number): boolean {
        let current = index;
        while (current !== -1) {
            if (current === bodyIndex) return true;
            // Use parentIndex if available; if not, break.
            current = parentIndex![current] ?? -1;
        }
        return false;
    }

    const seenBackendNodeId = new Set<number>();

    const promises = document.layout.nodeIndex.map(async (junk, nodeIndex): Promise<HTMLElementFeature | undefined> => {
        const i = layout.nodeIndex[nodeIndex];

        if (seenBackendNodeId.has(backendNodeId[i])) {
            return;
        }

        // only elements and documentElement are allowed
        // 1 = ELEMENT_NODE
        // 3 = TEXT_NODE
        if (![1, 3].includes(nodeType[i])) {
            // console.log("skipping, invalid node type", nodeIndex, nodeType);
            return;
        }

        const tagName = snapshot.strings[nodeName[i]].toLowerCase();
        if (["script", "style"].includes(tagName)) {
            return;
        }

        if (!isDescendantOfBody(i)) {
            // console.log(`skipping, ${tagName} not a descendant of body`, i, nodeType[i]);
            return;
        }

        const computedStyle: { [key: string]: string } = {};
        for (let styleIndex in document.layout.styles[nodeIndex]) {
            const stringIndex = document.layout.styles[nodeIndex][styleIndex];
            const property = computedStyles[Number(styleIndex)];
            computedStyle[property] = snapshot.strings[stringIndex];
        }

        const pseudoPosition = nodes.pseudoType ? nodes.pseudoType.index.indexOf(i) : -1;

        // let pseudoType;
        let realNodePosition = i;

        if (pseudoPosition > -1) {
            // const stringIndex = nodes.pseudoType!.value[pseudoPosition];
            // pseudoType = snapshot.strings[stringIndex];

            // lookin up parent node
            const parentNodePosition = parentIndex[i];
            if (parentNodePosition > -1) {
                realNodePosition = parentNodePosition;
            }
        }

        const [left, top, width, height] = layout.bounds[nodeIndex].map((value: number) => value * _magicRatio);

        // they can be undefined for things like documentElement
        // if (!top && !left && !width && !height) {
        //     // console.log("skipping, no dimensions", { nodeIndex, pseudoType, bbox: { left, top, width, height }, computedAttributes, computedStyle });
        //     return;
        // }

        const right = left + width;
        const bottom = top + height;
        const x = left;
        const y = top;

        const bbox = { top, right, bottom, left, width, height, x, y }; // we're going to reuse width & height

        // lets use reconstructedNodes to find the outerHTML
        // instead of "DOM.getOuterHTML"
        const node = reconstructedNodes.find((node) => node.backendNodeId === backendNodeId[realNodePosition]);
        if (!node) {
            if (nodeValue?.[i] && snapshot.strings[nodeValue[i]]?.trim()) {
                // this usually happens for spaces in between tags, so we can skip it
                console.error(`Node with backendNodeId ${backendNodeId[i]} not found in reconstructedNodes.`, snapshot.strings[nodeName[i]], JSON.stringify(snapshot.strings[nodeValue[i]]), nodeType[i], i, realNodePosition, bbox);
            }
            return;
        }
        // !!! we also need to strip the text nodes from the outerHTML
        // to construct outerHTMLWithoutText
        // let outerHTML = "";
        // try {
        //     const { outerHTML: html } = await client.send("DOM.getOuterHTML", {
        //         backendNodeId: backendNodeId[i],
        //     });
        //     outerHTML = html;
        // } catch (error) {
        //     console.error(`Error retrieving outerHTML for node ${backendNodeId[i]}:`, error);
        // }

        const { outerHTML, outerHTMLWithoutText, textContent } = node;
        const content = computedStyle.content === "normal" ? undefined : computedStyle.content;
        const parentId = i !== bodyIndex ? parentIndex[i] : undefined;

        seenBackendNodeId.add(backendNodeId[i]);

        return {
            id: i,
            parentId,
            nodeName: snapshot.strings[nodeName[i]].toLowerCase(),
            outerHTML,
            outerHTMLWithoutText,
            textContent: textContent.trim(),
            domPath: node.domPath,
            // outerHTMLVector: textToBigramVector(outerHTMLWithoutText),
            content,
            bbox,
        };
    });

    const results = await Promise.all(promises);
    const filteredResults = results.filter(Boolean) as HTMLElementFeature[];
    return filteredResults;
}
