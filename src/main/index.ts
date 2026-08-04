import { IComponent, getStudioProApi } from "@mendix/extensions-api";
import { calculateFlowLayout } from "./layoutEngine";
import { applyFlowLayout } from "./transaction";

// Document types this extension can format. Microflows and nanoflows share the same
// underlying structure (objectCollection + flows), so both use the same layout engine.
const SUPPORTED_DOCUMENTS = {
    "Microflows$Microflow": "microflow",
    "Microflows$Nanoflow": "nanoflow"
} as const;

type FlowKind = (typeof SUPPORTED_DOCUMENTS)[keyof typeof SUPPORTED_DOCUMENTS];

export const component: IComponent = {
    async loaded(componentContext) {
        // 1. Get the Studio Pro API instance
        const studioPro = getStudioProApi(componentContext);

        // 2. Destructure the necessary UI APIs
        const menuApi = studioPro.ui.extensionsMenu;
        const messageBoxApi = studioPro.ui.messageBoxes;

        // 3. Register the command in the top menu
        menuApi.add({
            menuId: "myextension.FormatMicroflowMenu",
            caption: "Auto-Format Active Microflow / Nanoflow",
            action: async () => {
                let kind: FlowKind = "microflow";
                try {
                    // 4. Fetch the document currently open in the Studio Pro canvas
                    const activeDocument = await studioPro.ui.editors.getActiveDocument();

                    if (!activeDocument) {
                        messageBoxApi.show("warning", "No document is currently open.");
                        return;
                    }

                    // 5. Make sure the active document is a microflow or a nanoflow
                    const documentType = activeDocument.documentType as keyof typeof SUPPORTED_DOCUMENTS;
                    if (!(documentType in SUPPORTED_DOCUMENTS)) {
                        messageBoxApi.show("warning", "Please open a Microflow or Nanoflow to format it.");
                        return;
                    }
                    kind = SUPPORTED_DOCUMENTS[documentType];

                    // 6. Use the App Model API to load the document by its ID
                    const targetId = activeDocument.documentId;
                    const modelApi = kind === "nanoflow"
                        ? studioPro.app.model.nanoflows
                        : studioPro.app.model.microflows;
                    const loadedDocuments = await modelApi.loadAll((info: any) => info.$ID === targetId);

                    if (loadedDocuments.length === 0) {
                        messageBoxApi.show("warning", `Could not load the active ${kind} from the app model.`);
                        return;
                    }

                    const activeFlow = loadedDocuments[0];

                    // 7. Extract objects and flows
                    // Objects (activities/events) live in objectCollection; flows are a separate list
                    const objects = activeFlow.objectCollection?.objects || [];
                    const flows = activeFlow.flows || [];

                    // 8. Calculate coordinates and apply them
                    const newCoordinates = calculateFlowLayout(objects, flows);
                    await applyFlowLayout(studioPro, activeFlow, newCoordinates, kind);

                } catch (error: any) {
                    console.error("Format extension failed:", error);
                    messageBoxApi.show("error", `Failed to format ${kind}.`, error.message || String(error));
                }
            }
        });
    }
};