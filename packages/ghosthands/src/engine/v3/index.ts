/**
 * GHOST-HANDS v3 Engine — Three-Layer Hybrid Execution
 *
 * Layers:
 *   Layer 1: DOMHand       — Pure DOM injection ($0/action)
 *   Layer 2: StagehandHand — Stagehand a11y observe + DOM fill ($0.0005/action)
 *   Layer 3: MagnitudeHand — Full GUI agent with vision LLM ($0.005/action)
 *
 * Orchestration:
 *   SectionOrchestrator — Selects cheapest layer, escalates on failure,
 *                         re-observes after every action.
 */

// Core
export { LayerHand } from './LayerHand';
export * from './types';

// Layers
export { DOMHand } from './layers/DOMHand';
export { StagehandHand } from './layers/StagehandHand';
export { MagnitudeHand } from './layers/MagnitudeHand';

// Orchestration
export { SectionOrchestrator, type OrchestratorResult } from './SectionOrchestrator';
export { SectionGrouper } from './SectionGrouper';

// Cookbook
export { CookbookExecutorV3, type CookbookV3Result } from './CookbookExecutorV3';

// Engine
export { V3ExecutionEngine, type V3ExecutionResult, type V3ExecutionParams } from './V3ExecutionEngine';
