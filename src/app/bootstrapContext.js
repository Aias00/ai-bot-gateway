import { loadRuntimeBootstrapConfig } from "./loadRuntimeBootstrapConfig.js";
import { buildRuntimeGraph } from "./buildRuntimeGraph.js";

export async function initializeRuntimeContext() {
  const configState = await loadRuntimeBootstrapConfig();
  const runtimeGraph = await buildRuntimeGraph(configState);
  return {
    ...configState,
    ...runtimeGraph
  };
}
