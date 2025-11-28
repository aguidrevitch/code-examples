import { Page, Protocol } from "puppeteer";
import { reconstructOuterHTML } from "./lib/reconstruct-outerhtml.mjs";
import { injectGenerateUniqueSelectors } from "./lib/generate-unique-selectors.mjs";
import { HTMLElementFeature } from "@watchero/types";

const computedStyles = ["content"];

// export interface HTMLElementFeature {
//     id: number;
//     parentId?: number;
//     nodeName: string;
//     outerHTML: string;
//     outerHTMLWithoutText: string;
//     textContent: string;
//     domPath?: string;
//     content?: string;
//     bbox: {
//         top: number;
//         right: number;
//         bottom: number;
//         left: number;
//         width: number;
//         height: number;
//         x: number;
//         y: number;
//     };
// }

function getAttributeValue(node: Protocol.DOM.Node, attrName: string): string | null {
    if (node.attributes && node.attributes.length > 0) {
        const index = node.attributes.findIndex((attr, i) => i % 2 === 0 && attr === attrName);
        if (index !== -1) {
            return node.attributes[index + 1] || null;
        }
    }
    return null;
}

export async function extractFeaturesFromHTML(page: Page, _magicRatio = 1): Promise<HTMLElementFeature[]> {
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
        throw new Error("Invalid snapshot data structure.");
    }

    if (!nodeType) {
        throw new Error("Invalid snapshot data structure.");
    }

    if (!backendNodeId) {
        throw new Error("Invalid snapshot data structure.");
    }

    if (!parentIndex) {
        throw new Error("Invalid layout data structure.");
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
        throw new Error("No <body> element found in snapshot.");
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

    // const results = nodes.backendNodeId?.map((junk, i) => {
    //     const nodeIndex = document.layout.nodeIndex.findIndex((value) => value === i);

    // Let me reason for my future self about this code:
    // layout in chromium 144 doesn't have some nodes that are visible, have width (2x186) 
    // and positionned absolutely, http://darwinapps.pl/ 
    // they will be reported missing by diff, but we don't want to workaround it
    // if I did it, I would iterate over all nodes here, eg nodes.backendNodeId
    // but then we can't distinguish nodes that actually disappeared from layout due to CSS changes
    const results = document.layout.nodeIndex.map((junk, nodeIndex): HTMLElementFeature | undefined => {
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
        // if (nodeIndex > -1) {
        for (let styleIndex in document.layout.styles[nodeIndex]) {
            const stringIndex = document.layout.styles[nodeIndex][styleIndex];
            const property = computedStyles[Number(styleIndex)];
            computedStyle[property] = snapshot.strings[stringIndex];
        }
        // }

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

        // let bbox = { top: -1, right: -2, bottom: -2, left: -1 }; // default invalid bbox
        // if (nodeIndex > -1) {
        const [left, top, width, height] = layout.bounds[nodeIndex].map((value: number) => value * _magicRatio);

        // they can be undefined for things like documentElement
        // if (!top && !left && !width && !height) {
        //     // console.log("skipping, no dimensions", { nodeIndex, pseudoType, bbox: { left, top, width, height }, computedAttributes, computedStyle });
        //     return;
        // }

        const right = left + width;
        const bottom = top + height;

        const bbox = { top, right, bottom, left }; // we're going to reuse width & height
        // }

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
        // let's find text node bbox if any
        const textBBoxIndexes = document.textBoxes.layoutIndex
            ?.map((layoutIndex, index) => (layoutIndex === nodeIndex ? index : -1))
            .filter((index) => index !== -1);
        const textBBoxes = textBBoxIndexes.map((textBoxIndex) => {
            const [left, top, width, height] = document.textBoxes.bounds[textBoxIndex].map(
                (value: number) => value * _magicRatio
            );
            return {
                left,
                top,
                right: left + width,
                bottom: top + height,
            };
        });
        if (textBBoxes.length === 0) {
            // special handling for ::before and ::after
            if (content) {
                textBBoxes.push(bbox);
            } else if (tagName === "input" || tagName === "textarea" || tagName === "submit") {
                if (getAttributeValue(node, "value")) {
                    textBBoxes.push(bbox);
                } else if (getAttributeValue(node, "placeholder")) {
                    textBBoxes.push(bbox);
                }
                textBBoxes.push(bbox);
            }
        }
        seenBackendNodeId.add(backendNodeId[i]);
        const nodeNameLower = snapshot.strings[nodeName[i]].toLowerCase();
        return {
            id: i,
            parentId,
            nodeName: snapshot.strings[nodeName[i]].toLowerCase(),
            outerHTML,
            outerHTMLWithoutText,
            textContent: textContent.trim(),
            domPath: node.domPath + (nodeNameLower.startsWith(":") ? nodeNameLower : ""),
            // outerHTMLVector: textToBigramVector(outerHTMLWithoutText),
            content,
            bbox,
            textBBoxes,
        };
    }); 

    const filteredResults = results.filter(Boolean) as HTMLElementFeature[];
    return filteredResults;
}
