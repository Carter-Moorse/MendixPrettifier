import { IComponent, getStudioProApi } from "@mendix/extensions-api";
import { LayoutEngine } from "./layoutEngine";
import { applyFlowLayout } from "./transaction";

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
                try {
                    // 4. Fetch the document currently open in the Studio Pro canvas
                    const activeDocument = await studioPro.ui.editors.getActiveDocument();

                    if (!activeDocument) {
                        messageBoxApi.show("warning", "No document is currently open.");
                        return;
                    }

                    // 5. Make sure the active document is a microflow or a nanoflow
                    if (!LayoutEngine.isSupported(activeDocument)) {
                        messageBoxApi.show("warning", "Please open a Microflow or Nanoflow to format it.");
                        return;
                    }

                    // 6. Use the App Model API to load the document by its ID
                    const kind = LayoutEngine.getKind(activeDocument);
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
                    const layoutEngine = new LayoutEngine(activeFlow);

                    // 8. Calculate coordinates and apply them
                    const newCoordinates = layoutEngine.calculateLayout();
                    await applyFlowLayout(studioPro, activeFlow, newCoordinates, kind);

                } catch (error: any) {
                    console.error("Format extension failed:", error);
                    messageBoxApi.show("error", "Failed to format.", error.message || String(error));
                }
            }
        });
    }
};