import { DocumentInfo, Microflows } from "@mendix/extensions-api";

// Document types this extension can format. Microflows and nanoflows share the same
// underlying structure (objectCollection + flows), so both use the same layout engine.
const SUPPORTED_DOCUMENTS = {
    "Microflows$Microflow": "microflow",
    "Microflows$Nanoflow": "nanoflow"
} as const;

type FlowKind = (typeof SUPPORTED_DOCUMENTS)[keyof typeof SUPPORTED_DOCUMENTS];

// Standardized Mendix object dimensions for the algorithm to calculate spacing
const MENDIX_SIZES = {
    action: { width: 120, height: 60 },      // e.g., Create Object, Java Action Call
    event: { width: 40, height: 40 },        // e.g., Start, End, Continue
    decision: { width: 80, height: 60 },     // e.g., Exclusive Split
    loop: { width: 250, height: 150 }        // e.g., Looped activities
};

const COLUMN_GAP = 80;   // horizontal space between columns
const ROW_GAP = 60;      // vertical space between rows (also leaves room for captions)
const CAPTION_SPACE = 30; // extra row height reserved for activity captions

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
 * Computes a left-to-right grid layout for a Mendix microflow or nanoflow by walking the
 * flow graph recursively, starting from its root objects (objects with no incoming flow —
 * typically start events) and following each outgoing flow until it dead-ends.
 *
 * Layout rules:
 * - The happy path flows left-to-right on one row.
 * - The connection ports the author drew are respected: a flow leaving a shape's
 *   bottom port places its target directly below (same column, next row); a flow
 *   leaving the right port continues on the same row. For flows without port
 *   information, decisions fall back to 'true' goes right / others go down.
 * - A node following another node in a chain stays on its predecessor's row, so
 *   activities line up with the previous activity on their left.
 * - A merge (a node reached again via a second incoming flow) is pulled back up to
 *   the highest row offered by its inputs, provided that flow actually "pins" the
 *   row (flows entering from below/behind a shape don't pin it).
 * - Loops (flows back to a node still on the current recursion path) are detected
 *   during the walk and never re-entered, so looped activities don't distort layout.
 * - Grid cells are claimed as nodes are placed, so no two shapes ever share a cell.
 */
export class LayoutEngine {
    private flow: Microflows.Nanoflow | Microflows.Microflow;
    private flowKind: FlowKind;

    // --- input-derived state ---
    private nodeSizes = new Map<string, { width: number; height: number }>();
    private objectTypes = new Map<string, string>();
    private nodeIds: string[] = [];
    private resolvedFlows: ResolvedFlow[] = [];
    private outgoingByNode = new Map<string, ResolvedFlow[]>();
    private incomingByNode = new Map<string, ResolvedFlow[]>();

    // --- traversal state ---
    private columnOf = new Map<string, number>();
    private rowOf = new Map<string, number>();
    private onStack = new Set<string>();   // nodes on the current recursion path (for back-edge detection)
    private visited = new Set<string>();   // nodes that have been placed at least once
    private backEdges = new Set<ResolvedFlow>();
    private occupied = new Set<string>();  // "col:row" cells already claimed

    constructor(flow: Microflows.Nanoflow | Microflows.Microflow) {
        this.flow = flow;

        const documentType = flow.$Type as keyof typeof SUPPORTED_DOCUMENTS;
        this.flowKind = SUPPORTED_DOCUMENTS[documentType];
    }

    /**
     * Runs the layout and returns the calculated { x, y } coordinate for every node
     * that participates in a flow. Objects with no flows (e.g. annotations) are not
     * included and keep their existing position.
     */
    calculateLayout(): Map<string, { x: number; y: number }> {
        const objects = this.flow.objectCollection?.objects || [];
        const flows = this.flow.flows || [];

        this.buildNodeMetadata(objects);
        this.buildFlowGraph(flows);
        this.assignGridPositions();
        return this.gridToCoordinates();
    }

    // ===================== setup =====================

    /** Records each object's size/type. Only objects that end up in a flow are laid out. */
    private buildNodeMetadata(objects: any[]): void {
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

            this.objectTypes.set(obj.$ID, type);
            this.nodeSizes.set(obj.$ID, size);
        });
    }

    /** Resolves raw flows into ResolvedFlow records and builds the adjacency maps. */
    private buildFlowGraph(flows: any[]): void {
        // In the extensions API, flow.origin/destination are the IDs (strings) of the connected objects
        this.resolvedFlows = flows
            .map(flow => ({
                origin: typeof flow.origin === "string" ? flow.origin : flow.origin?.$ID,
                dest: typeof flow.destination === "string" ? flow.destination : flow.destination?.$ID,
                caseValue: getCaseValue(flow),
                originPort: typeof flow.originConnectionIndex === "number" ? flow.originConnectionIndex : null,
                destPort: typeof flow.destinationConnectionIndex === "number" ? flow.destinationConnectionIndex : null,
                isDown: false
            }))
            .filter(f => f.origin && f.dest && this.nodeSizes.has(f.origin) && this.nodeSizes.has(f.dest));

        // Only lay out nodes that participate in flows; anything else (e.g. annotations)
        // keeps its current position.
        this.nodeIds = [...new Set(this.resolvedFlows.flatMap(f => [f.origin, f.dest]))];

        this.classifyDownFlows();
        this.buildAdjacency();
    }

    /**
     * Classifies each flow as a "down" branch.
     * Primary signal: the port the flow leaves from — a bottom exit means the target
     * belongs directly below its origin. This is what the author actually drew.
     * Fallback for flows without port information: at a decision, the 'true' flow
     * (or the first non-'false' one) continues right and the others go down.
     */
    private classifyDownFlows(): void {
        this.resolvedFlows.forEach(f => {
            f.isDown = f.originPort === PORT.BOTTOM;
        });

        const flowsByDecision = new Map<string, ResolvedFlow[]>();
        this.resolvedFlows.forEach(f => {
            if (f.originPort === null && (this.objectTypes.get(f.origin) || "").includes('ExclusiveSplit')) {
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
    }

    private buildAdjacency(): void {
        this.nodeIds.forEach(id => {
            this.outgoingByNode.set(id, []);
            this.incomingByNode.set(id, []);
        });
        this.resolvedFlows.forEach(f => {
            this.outgoingByNode.get(f.origin)!.push(f);
            this.incomingByNode.get(f.dest)!.push(f);
        });
    }

    // ===================== traversal =====================

    /** Objects that have only an outgoing flow (no incoming flow) — the walk's starting points. */
    private findRootNodes(): string[] {
        return this.nodeIds.filter(id => (this.incomingByNode.get(id) || []).length === 0);
    }

    /**
     * Starts the recursive walk at every root, then sweeps for any node that was never
     * reached (a fragment made entirely of a loop, or otherwise disconnected from a
     * root) and seeds it as a synthetic root so it still gets a position.
     */
    private assignGridPositions(): void {
        for (const rootId of this.findRootNodes()) {
            if (this.visited.has(rootId)) continue;
            this.visitNode(rootId, 0, this.nextFreeRowAtColumn(0));
        }

        for (const nodeId of this.nodeIds) {
            if (!this.visited.has(nodeId)) {
                this.visitNode(nodeId, 0, this.nextFreeRowAtColumn(0));
            }
        }
    }

    /**
     * Places `nodeId` at (col, row) — resolving any cell collision — then recursively
     * follows its outgoing flows until each path dead-ends at a node with no further
     * outgoing flow. A flow that leads back to a node still on the current recursion
     * path is a loop and is recorded but not followed; a flow that leads to a node
     * visited by an earlier branch is a merge and is reconciled rather than re-walked.
     */
    private visitNode(nodeId: string, col: number, row: number): void {
        this.visited.add(nodeId);
        this.onStack.add(nodeId);

        const placedRow = this.occupyCell(col, row);
        this.columnOf.set(nodeId, col);
        this.rowOf.set(nodeId, placedRow);

        for (const flow of this.getOrderedOutgoing(nodeId)) {
            if (this.onStack.has(flow.dest)) {
                // Back edge: the flow loops back to an ancestor on the current path.
                this.backEdges.add(flow);
                continue;
            }

            if (this.visited.has(flow.dest)) {
                // Merge: another branch already placed this node. Pull it toward the
                // main path if this flow is allowed to pin its row.
                this.reconcileMerge(flow, col, placedRow);
                continue;
            }

            const child = this.computeChildPosition(flow, col, placedRow);
            this.visitNode(flow.dest, child.col, child.row);
        }

        this.onStack.delete(nodeId);
    }

    /**
     * Returns a node's outgoing flows in a fixed order: the flow that continues the
     * row (the decision's "true"/happy-path flow, or any non-down flow) is followed
     * before any "down" branch, so the main path is walked to completion first —
     * matching the rule that the happy path lays out left-to-right on a single row.
     */
    private getOrderedOutgoing(nodeId: string): ResolvedFlow[] {
        const flows = this.outgoingByNode.get(nodeId) || [];
        return [...flows].sort((a, b) => Number(a.isDown) - Number(b.isDown));
    }

    /**
     * Determines where a newly-discovered child belongs relative to its parent:
     * a bottom exit (or a flow entering the target's top port) places it directly
     * below in the same column; any other flow continues the row one column right.
     * (A flow leaving the parent's own top port targets something earlier in the
     * flow, so it is always resolved as a back edge or a merge above, never here.)
     */
    private computeChildPosition(flow: ResolvedFlow, originCol: number, originRow: number): { col: number; row: number } {
        const isDownFlow = flow.isDown || flow.destPort === PORT.TOP;
        if (isDownFlow) {
            return { col: originCol, row: originRow + 1 };
        }
        return { col: originCol + 1, row: originRow };
    }

    /**
     * Reconciles a merge: if this flow is allowed to pin the target's row (i.e. it
     * doesn't enter from below or behind), and the row it offers is closer to the
     * main path than the target's current row, the target is pulled up to it.
     *
     * Note: this only moves the merge node itself, not anything already placed
     * downstream of it — the original constraint-solver recomputed every row in one
     * pass, but re-walking an already-placed subtree here risks re-visiting loops.
     * In practice merges sit near the end of a branch, so this is a safe simplification.
     */
    private reconcileMerge(flow: ResolvedFlow, originCol: number, originRow: number): void {
        const pinsRow = !(flow.originPort === PORT.TOP || flow.destPort === PORT.BOTTOM || flow.destPort === PORT.RIGHT);
        if (!pinsRow) return;

        const isDownFlow = flow.isDown || flow.destPort === PORT.TOP;
        const candidateRow = isDownFlow ? originRow + 1 : originRow;

        const nodeId = flow.dest;
        const currentRow = this.rowOf.get(nodeId)!;
        if (candidateRow >= currentRow) return; // no improvement — already at least as close to the main path

        const col = this.columnOf.get(nodeId)!;
        this.occupied.delete(`${col}:${currentRow}`);
        this.rowOf.set(nodeId, this.occupyCell(col, candidateRow));
    }

    /** Claims the first free row at `col`, starting from `desiredRow`, and marks it occupied. */
    private occupyCell(col: number, desiredRow: number): number {
        let row = desiredRow;
        while (this.occupied.has(`${col}:${row}`)) {
            row++;
        }
        this.occupied.add(`${col}:${row}`);
        return row;
    }

    /** The first unclaimed row at `col`, used to give each disconnected root its own space. */
    private nextFreeRowAtColumn(col: number): number {
        let maxRow = -1;
        this.occupied.forEach(key => {
            const [colStr, rowStr] = key.split(":");
            if (Number(colStr) === col) {
                maxRow = Math.max(maxRow, Number(rowStr));
            }
        });
        return maxRow + 1;
    }

    // ===================== coordinates =====================

    /**
     * Converts the grid to pixel coordinates.
     * Column width = widest node in the column; row height = tallest node in the row.
     * Rows containing activities get extra space for the captions rendered below them.
     */
    private gridToCoordinates(): Map<string, { x: number; y: number }> {
        const columnWidths = new Map<number, number>();
        const rowHeights = new Map<number, number>();

        this.nodeIds.forEach(id => {
            const { width, height } = this.nodeSizes.get(id)!;
            const type = this.objectTypes.get(id) || "";
            const hasCaption = type.includes('ActionActivity') || type.includes('LoopedActivity');
            const col = this.columnOf.get(id)!;
            const row = this.rowOf.get(id)!;
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

        const newCoordinates = new Map<string, { x: number; y: number }>();
        this.nodeIds.forEach(id => {
            newCoordinates.set(id, {
                x: Math.round(columnCenters.get(this.columnOf.get(id)!)!),
                y: Math.round(rowCenters.get(this.rowOf.get(id)!)!)
            });
        });

        return newCoordinates;
    }

    public static getKind(document: DocumentInfo): FlowKind {
        return SUPPORTED_DOCUMENTS[document.documentType as keyof typeof SUPPORTED_DOCUMENTS];
    }

    public static isSupported(document: DocumentInfo): boolean {
        const documentType = LayoutEngine.getKind(document);
        return (documentType in SUPPORTED_DOCUMENTS);
    } 
}

/**
 * Calculates new X/Y coordinates for Mendix microflow or nanoflow objects to align them
 * left-to-right on a column/row grid. Both document types use the same object and flow
 * structure, so a single engine handles them.
 *
 * @param objects Array of flow objects from the active document
 * @param flows Array of Sequence flows connecting the objects
 * @returns A Map of the object ID to its new { x, y } coordinates
 */
