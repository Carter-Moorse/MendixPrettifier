// Standardized Mendix object dimensions for the algorithm to calculate spacing
const MENDIX_SIZES = {
    action: { width: 120, height: 60 },      // e.g., Create Object, Java Action Call
    event: { width: 40, height: 40 },        // e.g., Start, End, Continue
    decision: { width: 80, height: 60 },     // e.g., Exclusive Split
    loop: { width: 250, height: 150 }        // e.g., Looped activities
};

const COLUMN_GAP = 80;  // horizontal space between columns
const ROW_GAP = 60;     // vertical space between rows (also leaves room for captions)

// Connection port indexes on microflow shapes, clockwise from the top
const PORT = { TOP: 0, RIGHT: 1, BOTTOM: 2, LEFT: 3 };

interface ResolvedFlow {
    origin: string;
    dest: string;
    caseValue: string | null;
    originPort: number | null;
    destPort: number | null;
    isDown: boolean;
}

/**
 * Reads the case value ("true" / "false" / enum value) of a sequence flow, if any.
 */
function getCaseValue(flow: any): string | null {
    for (const caseValue of flow.caseValues || []) {
        if (typeof caseValue.value === "string") {
            return caseValue.value.toLowerCase();
        }
    }
    return null;
}

/**
 * Calculates new X/Y coordinates for Mendix microflow or nanoflow objects to align them
 * left-to-right on a column/row grid. Both document types use the same object and flow
 * structure, so a single engine handles them.
 *
 * Layout rules:
 * - The happy path flows left-to-right on one row.
 * - The connection ports the author drew are respected: a flow leaving a shape's
 *   bottom port places its target directly below (same column, next row); a flow
 *   leaving the top port aligns both shapes in the same column (vertical arrow up);
 *   a flow leaving the right port continues on the same row. For flows without port
 *   information, decisions fall back to 'true' goes right / others go down.
 * - A node following another node in a chain stays on its predecessor's row, so
 *   activities line up with the previous activity on their left.
 * - A merge returns to the highest (closest to the main path) row of its inputs;
 *   flows entering a shape from below or behind don't pin its row.
 * - Stacked decisions keep stacking rows downward; grid cells are never shared.
 *
 * @param objects Array of flow objects from the active document
 * @param flows Array of Sequence flows connecting the objects
 * @returns A Map of the object ID to its new { x, y } coordinates
 */
export function calculateFlowLayout(
    objects: any[],
    flows: any[]
): Map<string, { x: number, y: number }> {

    // 1. Collect node sizes and types
    const nodeSizes = new Map<string, { width: number, height: number }>();
    const objectTypes = new Map<string, string>();

    objects.forEach(obj => {
        const type = obj.$Type || "";
        let size = MENDIX_SIZES.action;

        if (type.includes('Event')) {
            size = MENDIX_SIZES.event;
        } else if (type.includes('ExclusiveSplit')) {
            size = MENDIX_SIZES.decision;
        } else if (type.includes('LoopedActivity')) {
            size = MENDIX_SIZES.loop;
        }

        objectTypes.set(obj.$ID, type);
        nodeSizes.set(obj.$ID, size);
    });

    // 2. Resolve flow endpoints
    // In the extensions API, flow.origin/destination are the IDs (strings) of the connected objects
    const resolvedFlows: ResolvedFlow[] = flows
        .map(flow => ({
            origin: typeof flow.origin === "string" ? flow.origin : flow.origin?.$ID,
            dest: typeof flow.destination === "string" ? flow.destination : flow.destination?.$ID,
            caseValue: getCaseValue(flow),
            originPort: typeof flow.originConnectionIndex === "number" ? flow.originConnectionIndex : null,
            destPort: typeof flow.destinationConnectionIndex === "number" ? flow.destinationConnectionIndex : null,
            isDown: false
        }))
        .filter(f => f.origin && f.dest && nodeSizes.has(f.origin) && nodeSizes.has(f.dest));

    // Only lay out nodes that participate in flows; anything else (e.g. annotations)
    // keeps its current position.
    const nodeIds = [...new Set(resolvedFlows.flatMap(f => [f.origin, f.dest]))];

    // 3. Classify flows as "down" branches.
    // Primary signal: the port the flow leaves from — a bottom exit means the target
    // belongs directly below its origin. This is what the author actually drew.
    resolvedFlows.forEach(f => {
        f.isDown = f.originPort === PORT.BOTTOM;
    });

    // Fallback for flows without port information: at a decision, the 'true' flow
    // (or the first non-'false' one) continues right and the others go down.
    const flowsByDecision = new Map<string, ResolvedFlow[]>();
    resolvedFlows.forEach(f => {
        if (f.originPort === null && (objectTypes.get(f.origin) || "").includes('ExclusiveSplit')) {
            const list = flowsByDecision.get(f.origin) || [];
            list.push(f);
            flowsByDecision.set(f.origin, list);
        }
    });

    flowsByDecision.forEach(outgoing => {
        if (outgoing.length < 2) return; // nothing to branch

        const rightFlow =
            outgoing.find(f => f.caseValue === "true") ||
            outgoing.find(f => f.caseValue !== "false") ||
            outgoing[0];

        outgoing.forEach(f => {
            f.isDown = f !== rightFlow;
        });
    });

    // 4. DFS: detect back edges (loops) and produce a topological order
    const outgoing = new Map<string, ResolvedFlow[]>();
    const incoming = new Map<string, ResolvedFlow[]>();
    nodeIds.forEach(id => {
        outgoing.set(id, []);
        incoming.set(id, []);
    });
    resolvedFlows.forEach(f => {
        outgoing.get(f.origin)!.push(f);
        incoming.get(f.dest)!.push(f);
    });

    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>(nodeIds.map(id => [id, WHITE]));
    const topoOrder: string[] = [];
    const backEdges = new Set<ResolvedFlow>();

    const visit = (id: string) => {
        color.set(id, GRAY);
        for (const f of outgoing.get(id) || []) {
            const c = color.get(f.dest);
            if (c === WHITE) {
                visit(f.dest);
            } else if (c === GRAY) {
                backEdges.add(f);
            }
        }
        color.set(id, BLACK);
        topoOrder.push(id);
    };
    // Prefer starting DFS at nodes without incoming flows (start events)
    const dfsRoots = [
        ...nodeIds.filter(id => (incoming.get(id) || []).length === 0),
        ...nodeIds
    ];
    dfsRoots.forEach(id => {
        if (color.get(id) === WHITE) visit(id);
    });
    topoOrder.reverse();

    // 5. Assign columns via a small constraint system.
    // - A horizontal flow requires its target to be at least one column further right.
    // - A vertical flow (leaving the bottom or top port) wants both endpoints in the
    //   SAME column: the forward direction (dest >= origin) is always enforced, and the
    //   reverse "pull" (origin >= dest) is only accepted when it cannot contradict the
    //   horizontal constraints — alignment is best-effort where geometrically possible.
    interface ColConstraint { from: string; to: string; len: number; } // col(to) >= col(from) + len

    const colConstraints: ColConstraint[] = [];
    const pullCandidates: ColConstraint[] = [];

    resolvedFlows.forEach(f => {
        if (backEdges.has(f)) return;
        const isVertical = f.isDown || f.originPort === PORT.TOP;
        if (isVertical) {
            colConstraints.push({ from: f.origin, to: f.dest, len: 0 });
            pullCandidates.push({ from: f.dest, to: f.origin, len: 0 });
        } else {
            colConstraints.push({ from: f.origin, to: f.dest, len: 1 });
        }
    });

    const columnOf = new Map<string, number>(nodeIds.map(id => [id, 0]));
    const relaxColumns = () => {
        const maxPasses = nodeIds.length + colConstraints.length + 5;
        for (let pass = 0; pass < maxPasses; pass++) {
            let changed = false;
            for (const c of colConstraints) {
                const required = columnOf.get(c.from)! + c.len;
                if (columnOf.get(c.to)! < required) {
                    columnOf.set(c.to, required);
                    changed = true;
                }
            }
            if (!changed) return;
        }
    };
    relaxColumns();

    // A pull (col(to) >= col(from)) is only safe if there is no positive-length path
    // to -> from among the accepted constraints; otherwise the system would be
    // unsatisfiable (columns would be pushed right forever).
    const hasPositivePath = (start: string, goal: string): boolean => {
        const adjacency = new Map<string, ColConstraint[]>();
        colConstraints.forEach(c => {
            const list = adjacency.get(c.from) || [];
            list.push(c);
            adjacency.set(c.from, list);
        });
        const seen = new Set<string>();
        const stack: Array<{ id: string, positive: boolean }> = [{ id: start, positive: false }];
        while (stack.length > 0) {
            const { id, positive } = stack.pop()!;
            if (id === goal && positive) return true;
            const key = `${id}:${positive}`;
            if (seen.has(key)) continue;
            seen.add(key);
            for (const c of adjacency.get(id) || []) {
                stack.push({ id: c.to, positive: positive || c.len > 0 });
            }
        }
        return false;
    };

    pullCandidates.forEach(pull => {
        if (!hasPositivePath(pull.to, pull.from)) {
            colConstraints.push(pull);
        }
    });
    relaxColumns();

    // 6. Assign rows in topological order:
    // - a flow leaving the bottom (or entering the top) pushes its target one row down
    // - a flow entering the target's bottom or right side comes from below/behind,
    //   so it doesn't pin the target's row at all
    // - any other flow keeps its target on the origin's row (chains stay level)
    // - a node with multiple pinning flows (merge) takes the highest row of its
    //   inputs, returning to the main path
    const rowOf = new Map<string, number>();
    topoOrder.forEach(id => {
        const contributions = (incoming.get(id) || [])
            .filter(f => !backEdges.has(f) && rowOf.has(f.origin))
            .map(f => {
                const originRow = rowOf.get(f.origin)!;
                if (f.isDown || f.destPort === PORT.TOP) return originRow + 1;
                if (f.originPort === PORT.TOP || f.destPort === PORT.BOTTOM || f.destPort === PORT.RIGHT) return null;
                return originRow;
            })
            .filter((row): row is number => row !== null);

        rowOf.set(id, contributions.length > 0 ? Math.min(...contributions) : 0);
    });

    // 7. Resolve grid collisions: no two nodes may share a (column, row) cell.
    // Later nodes in topological order get bumped down.
    const occupied = new Set<string>();
    topoOrder.forEach(id => {
        const col = columnOf.get(id)!;
        let row = rowOf.get(id)!;
        while (occupied.has(`${col}:${row}`)) {
            row++;
        }
        rowOf.set(id, row);
        occupied.add(`${col}:${row}`);
    });

    // 8. Convert the grid to coordinates.
    // Column width = widest node in the column; row height = tallest node in the row.
    // Rows containing activities get extra space for the captions rendered below them.
    const CAPTION_SPACE = 30;
    const columnWidths = new Map<number, number>();
    const rowHeights = new Map<number, number>();
    nodeIds.forEach(id => {
        const { width, height } = nodeSizes.get(id)!;
        const type = objectTypes.get(id) || "";
        const hasCaption = type.includes('ActionActivity') || type.includes('LoopedActivity');
        const col = columnOf.get(id)!;
        const row = rowOf.get(id)!;
        columnWidths.set(col, Math.max(columnWidths.get(col) || 0, width));
        rowHeights.set(row, Math.max(rowHeights.get(row) || 0, height + (hasCaption ? CAPTION_SPACE : 0)));
    });

    const columnCenters = new Map<number, number>();
    let x = 0;
    [...columnWidths.keys()].sort((a, b) => a - b).forEach(col => {
        const width = columnWidths.get(col)!;
        columnCenters.set(col, x + width / 2);
        x += width + COLUMN_GAP;
    });

    const rowCenters = new Map<number, number>();
    let y = 0;
    [...rowHeights.keys()].sort((a, b) => a - b).forEach(row => {
        const height = rowHeights.get(row)!;
        rowCenters.set(row, y + height / 2);
        y += height + ROW_GAP;
    });

    // 9. Extract calculated coordinates
    const newCoordinates = new Map<string, { x: number, y: number }>();
    nodeIds.forEach(id => {
        newCoordinates.set(id, {
            x: Math.round(columnCenters.get(columnOf.get(id)!)!),
            y: Math.round(rowCenters.get(rowOf.get(id)!)!)
        });
    });

    return newCoordinates;
}
