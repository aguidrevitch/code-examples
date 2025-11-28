import { Protocol } from "puppeteer";
interface NodeWithOuterHTML extends Protocol.DOM.Node {
    outerHTML: string;
    outerHTMLWithoutText: string;
    textContent: string;
    domPath?: string;
}

const textContentAttributes = [
    "img|alt",
    "img|title",
    "a|title",
    "input|placeholder",
    "input|value",
    "option|label",
    "details|summary",
    "table|caption",
    "abbr|title",
    "|aria-label",
];

const excludeAttributesForStructuralTags = [
    "script|",
    "style|",
    "link|",
    "img|src",
    "img|width",
    "img|height",
    "img|srcset",
    "a|href",
    "area|href",
    "source|src",
    "source|srcset",
    "track|src",
    "audio|src",
    "video|src",
    "video|width",
    "video|height",
    "video|poster",
    "iframe|src",
    "iframe|width",
    "iframe|height",
    "object|data",
    "embed|src",
    "form|action",
    "|onload",
];

const dataUriRegex = /^data:([a-z]+\/[a-z0-9.+-]+)?(;[a-z-]+=[a-z0-9-]+)*(;base64)?,([a-z0-9!$&',()*+;=\-._~:@/?%\s]*)$/i;

function computeTextContent(node: Protocol.DOM.Node): string {
    if (node.nodeType === 3) {
        // Text node
        return node.nodeValue ? " " + node.nodeValue + " " : "";
    } else if (node.nodeType === 1) {
        // Element node
        const tag = node.nodeName.toLowerCase();
        let textContent = "";
        if (node.attributes && node.attributes.length > 0) {
            // Attributes are given in an array [name, value, name, value, ...]
            for (let i = 0; i < node.attributes.length; i += 2) {
                if (
                    textContentAttributes.includes(`${tag}|${node.attributes[i]}`) ||
                    textContentAttributes.includes(`|${node.attributes[i]}`) ||
                    textContentAttributes.includes(`${tag}|`)
                ) {
                    textContent += node.attributes[i + 1] 
                        ? " " + node.attributes[i + 1] + " "
                        : "";
                }
            }
        }
        if (tag === "script" || tag === "style") {
            // We don't want to include the content of script or style tags in the text content.
            return textContent;
        }
        if (node.children) {
            for (const child of node.children) {
                textContent += computeTextContent(child);
            }
        }
        return textContent;
    }
    // For other node types (e.g. comments) return an empty string.
    return "";
}

// This helper computes the outerHTML for a given node.
// For element nodes, it only includes element children (stripping text nodes).
// For text nodes, it simply returns the text content.
function computeOuterHTML(node: Protocol.DOM.Node, includeText: boolean = false): string {
    if (node.nodeType === 3) {
        // Text node
        return node.nodeValue || "";
    } else if (node.nodeType === 1) {
        // Element node
        const tag = node.nodeName.toLowerCase();
  
        let attrStr = "";
        if (node.attributes && node.attributes.length > 0) {
            // Attributes are given in an array [name, value, name, value, ...]
            for (let i = 0; i < node.attributes.length; i += 2) {
                const attrName = node.attributes[i];
                if (attrName === "data-watchero-selector") {
                    // Skip selector attribute.
                    continue;
                }
                if (attrName.startsWith("data-fpo-") || attrName.startsWith("data-wpmeteor-")) {
                    // Skip fastpixel-related attributes
                    continue;
                }
                if (attrName === "id" && node.attributes[i + 1].match(/^fpo[0-9]+$/)) {
                    // Skip fastpixel element IDs
                    continue;
                }
                if (!includeText) {
                    if (
                        // Skip data-* attributes, as data in them doesn't reflect structure
                        // and is rather item-specific.
                        attrName.startsWith("data-") ||
                        textContentAttributes.includes(`${tag}|${attrName}`) ||
                        textContentAttributes.includes(`|${attrName}`) ||
                        textContentAttributes.includes(`${tag}|`) ||
                        excludeAttributesForStructuralTags.includes(`${tag}|${attrName}`) ||
                        excludeAttributesForStructuralTags.includes(`|${attrName}`) ||
                        excludeAttributesForStructuralTags.includes(`${tag}|`)
                    ) {
                        // we still want to include the attribute name
                        // but not the value
                        attrStr += ` ${attrName}=""`;
                        continue;
                    }
                }
                let attrValue = dataUriRegex.test(node.attributes[i + 1])
                    ? node.attributes[i + 1].replace(",.*", ",...")
                    : node.attributes[i + 1];
                // attrValue = attrValue.replace(/fpo-lazyloaded/g, "");
                const updatedAttrValue = attrValue.replace(/fpo-lazyloaded/g, "").trim();
                if (attrName === "class" && updatedAttrValue !== attrValue && updatedAttrValue === "") {
                    // skip empty class attributes
                    continue;
                }
                attrStr += ` ${attrName}="${updatedAttrValue}"`;
            }
        }
        if (tag === "script" || tag === "style" || tag === "link" || tag === "meta") {
            return `<${tag}${attrStr}></${tag}>`;
        }
        // Only include child nodes that are elements.
        let innerHTML = "";
        if (node.children) {
            for (const child of node.children) {
                if (includeText) {
                    // Include text nodes as well.
                    innerHTML += computeOuterHTML(child, true);
                } else {
                    // Only include element nodes.
                    if (child.nodeType === 1) {
                        innerHTML += computeOuterHTML(child, includeText);
                    }
                }
            }
        }
        return `<${tag}${attrStr}>${innerHTML}</${tag}>`;
    }
    // For other node types (e.g. comments) return an empty string.
    return "";
}

function getDOMPath(node: Protocol.DOM.Node): string | undefined {
    if (node.nodeType === 9) {
        // A Document node
        return;
    }
    if (node.nodeType === 10) {
        // <!DOCTYPE html>
        return;
    }
    // if (node.nodeType === 3) {
    //     // Text node
    //     return;
    // }
    // Attributes are given in an array [name, value, name, value, ...]
    if (node.attributes && node.attributes.length > 0) {
        for (let i = 0; i < node.attributes.length; i += 2) {
            const attrName = node.attributes[i];
            if (attrName === "data-watchero-selector") {
                // Skip selector attribute.
                return node.attributes[i + 1];
            }
        }
    }
    throw new Error("No selector found for the node: " + computeOuterHTML(node));
}

export function reconstructOuterHTML(node: Protocol.DOM.Node): NodeWithOuterHTML[] {
    const result: NodeWithOuterHTML[] = [];

    const textCounter = new Map<string, number>();
    const commentCounter = new Map<string, number>();
    // Pre-order traverse the tree to compute and collect each node's HTML.
    function traverse(node: Protocol.DOM.Node, parentDomPath?: string): void {
        const outerHTML = computeOuterHTML(node, true);
        const outerHTMLWithoutText = computeOuterHTML(node, false);
        const textContent = computeTextContent(node);

        let domPath: string | undefined;
        // Special handling for text and comment nodes to ensure uniqueness
        if (node.nodeType === 3) {
            let n = textCounter.get(parentDomPath || "") || 1;
            textCounter.set(parentDomPath || "", n + 1);
            domPath = parentDomPath + " > " + `:nth-text-node(${n})`;
        } else if (node.nodeType === 8) {
            let n = commentCounter.get(parentDomPath || "") || 1;
            commentCounter.set(parentDomPath || "", n + 1);
            domPath = parentDomPath + " > " + `:nth-comment-node(${n})`;
        } else {
            domPath = getDOMPath(node);
        }

        result.push({ ...node, outerHTML, outerHTMLWithoutText, textContent, domPath });
        if (node.children) {
            for (const child of node.children) {
                traverse(child, domPath);
            }
        }
    }

    traverse(node);
    return result;
}
