import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ComponentContext, IComponent } from "@mendix/extensions-api";

export const component: IComponent = {
    async loaded(componentContext: ComponentContext) {
        createRoot(document.getElementById("root")!).render(
            <StrictMode>
                <h1>Mendix Studio Pro Extension</h1>
                <p>Hello from AutoPrettifier!</p>
            </StrictMode>
        );
    }
}
