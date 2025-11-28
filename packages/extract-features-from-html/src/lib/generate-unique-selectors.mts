/**
 * Generates unique CSS selectors for all elements in the document
 * using a DOM TreeWalker with iterative approach
 */
interface NodeData {
    node: Element;
    tag: string;
    classes: string[];
    id: string;
    href: string | null;
    src: string | null;
}
interface ParentData {
    children: NodeData[];
    tagCounts: Record<string, number>;
    classFrequency: Record<string, number>;
    hrefValues: Record<string, number>;
    srcValues: Record<string, number>;
    idValues: Record<string, number>;
    selector?: string;
}

declare global {
    interface Window {
        generateUniqueSelectors: () => Map<Element, string>;
        // ensureGlobalUniqueness: (_nodeSelectors: Map<Element, string>) => void;
    }
}

export const injectGenerateUniqueSelectors = function (): void {

    function generateUniqueSelectors(): Map<Element, string> {
        // Create a tree walker to iterate through all element nodes
        let walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);

        // Store siblings at each parent level
        const parentMap: Map<Element, ParentData> = new Map();
        // Store the final selectors for each node
        const nodeSelectors: Map<Element, string> = new Map();

        // Keep track of the current node
        let currentNode = walker.currentNode as Element;

        while (currentNode) {
            const parent = currentNode.parentElement;

            // Skip if this is the document element (we'll start with child elements)
            if (!parent) {
                currentNode = walker.nextNode() as Element;
                continue;
            }

            // Initialize parent map entry if this is the first child we've seen
            if (!parentMap.has(parent)) {
                parentMap.set(parent, {
                    children: [],
                    tagCounts: {},
                    classFrequency: {},
                    hrefValues: {},
                    srcValues: {},
                    idValues: {},
                });
            }

            const parentData = parentMap.get(parent)!;

            // this is needed for properly addressing various
            // interception of getAttribute calls, eg in Fastpixel
            const clonedNode = currentNode.cloneNode(false) as Element;
            const tag = currentNode.tagName.toLowerCase();

            // Process the current node
            const nodeData: NodeData = {
                node: currentNode,
                tag,
                classes: Array.from(clonedNode.classList),
                id: clonedNode.id,
                href: clonedNode.getAttribute("href"),
                src: clonedNode.getAttribute("src"),
            };

            // Update tag count
            parentData.tagCounts[tag] = (parentData.tagCounts[tag] || 0) + 1;

            // Update class frequency
            nodeData.classes.forEach((cls) => {
                parentData.classFrequency[cls] = (parentData.classFrequency[cls] || 0) + 1;
            });

            // Update href values
            if (nodeData.href) {
                parentData.hrefValues[nodeData.href] = (parentData.hrefValues[nodeData.href] || 0) + 1;
            }

            // Update src values
            if (nodeData.src) {
                parentData.srcValues[nodeData.src] = (parentData.srcValues[nodeData.src] || 0) + 1;
            }

            // Update id values
            if (nodeData.id) {
                parentData.idValues[nodeData.id] = (parentData.idValues[nodeData.id] || 0) + 1;
            }

            // Add node data to parent's children
            parentData.children.push(nodeData);

            // Update selectors for all children of this parent
            // This handles the retrospective modification
            // updateSelectorsForParent(parentData, nodeSelectors);

            // Move to the next node
            currentNode = walker.nextNode() as Element;
        }


        // Create a tree walker to iterate through all element nodes
        walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);

        // Keep track of the current node
        currentNode = walker.currentNode as Element;

        while (currentNode) {
            let parent = currentNode.parentElement;

            // Skip if this is the document element (we'll start with child elements)
            if (!parent) {
                currentNode = walker.nextNode() as Element;
                continue;
            }

            const parentData = parentMap.get(parent)!;
            const tag = currentNode.tagName.toLowerCase();

            // this is needed for properly addressing various
            // interception of getAttribute calls, eg in Fastpixel
            const clonedNode = currentNode.cloneNode(false) as Element;
            // Process the current node
            const nodeData: NodeData = {
                node: currentNode,
                tag,
                classes: Array.from(clonedNode.classList),
                id: clonedNode.id,
                href: clonedNode.getAttribute("href"),
                src: clonedNode.getAttribute("src"),
            };
            const selector = getBestSelector(nodeData, parentData);
            const parts = [selector];

            let ancestor: HTMLElement | null = parent;

            // Walk up until <html>
            while (ancestor && ancestor !== document.documentElement) {
                // selector for this ancestor must be unique among *its* siblings
                const ancestorParent: HTMLElement | null = ancestor.parentElement;
                if (!ancestorParent) {
                    break;
                }

                const ancestorParentData = parentMap.get(ancestorParent);
                if (!ancestorParentData) {
                    break;
                }

                // this is needed for properly addressing various
                // interception of getAttribute calls, eg in Fastpixel
                const clonedAncestor = ancestor.cloneNode(false) as Element;
                // Process ancestor node
                const ancestorData: NodeData = {
                    node: ancestor,
                    tag: clonedAncestor.tagName.toLowerCase(),
                    classes: Array.from(clonedAncestor.classList),
                    id: clonedAncestor.id,
                    href: clonedAncestor.getAttribute("href"),
                    src: clonedAncestor.getAttribute("src"),
                };

                const ancestorSelector = getBestSelector(ancestorData, ancestorParentData);

                parts.unshift(ancestorSelector);

                // go one level higher
                ancestor = ancestorParent;
            }

            if (currentNode !== document.documentElement) {
                // Ensure selectors always anchor at the root to avoid duplicate matches.
                parts.unshift("html");
            }

            const fullSelector = parts.join(" > ");
            nodeSelectors.set(currentNode, fullSelector);

            // Move to the next node
            currentNode = walker.nextNode() as Element;
        }
        
        // Initialize the document element
        nodeSelectors.set(document.documentElement, "html");

        // Print all selectors
        nodeSelectors.forEach((selector) => {
            // Validate selector
            const currentNode = document.querySelectorAll(selector);
            if (currentNode.length !== 1) {
                throw new Error(`Selector "${selector}" matches ${currentNode.length} elements!`);
            }
            currentNode[0].setAttribute("data-watchero-selector", selector);
        });

        return nodeSelectors;
    }

    /**
     * Generates the best possible selector without position information
     */
    function getBestSelector(nodeData: NodeData, parentData: ParentData): string {
        const { tag, classes, id, href, src } = nodeData;

        // 1. Try to use ID if it exists and is unique
        if (id && parentData.idValues[id] === 1) {
            return `#${escapeAttribute(id)}`;
        }

        // 2. Try to find a unique class
        const uniqueClasses = classes.filter((cls) => parentData.classFrequency[cls] === 1);
        if (uniqueClasses.length > 0) {
            return `${escapeAttribute(tag)}.${escapeAttribute(uniqueClasses[0])}`;
        }

        // 3. Try to use unique href
        if (href && parentData.hrefValues[href] === 1) {
            return `${escapeAttribute(tag)}[href="${escapeAttribute(href)}"]`;
        }

        // 4. Try to use unique src
        if (src && parentData.srcValues[src] === 1) {
            return `${escapeAttribute(tag)}[src="${escapeAttribute(src)}"]`;
        }

        if (parentData.tagCounts[tag] > 1) {
            // 5. If the tag is not unique, use nth-child
            const index = Array.from(parentData.children).findIndex((child) => child.node === nodeData.node) + 1;
            return `${escapeAttribute(tag)}:nth-child(${index})`;
        }

        // 5. Just use the tag name - positioning will be added later if needed
        return escapeAttribute(tag);
    }

    /**
     * Helper function to escape special characters in attribute values
     */
    function escapeAttribute(value: string): string {
        return CSS.escape(value);
        // return value.replace(/"/g, '\\"');
    }

    window.generateUniqueSelectors = generateUniqueSelectors;
};
