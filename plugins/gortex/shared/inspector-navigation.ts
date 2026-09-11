import type { InspectorOperation, InspectorSymbol } from "./symbol-inspection.ts";

export type SymbolSelection = Pick<InspectorSymbol, "id" | "name" | "kind" | "filePath" | "line">;
export type InspectorLocation = { symbol: SymbolSelection; operation: InspectorOperation };
export type InspectorNavigation = { current: InspectorLocation | null; back: InspectorLocation[]; forward: InspectorLocation[] };
export const emptyNavigation: InspectorNavigation = { current: null, back: [], forward: [] };
type NavigationAction =
  | { type: "select"; symbol: SymbolSelection; root?: boolean }
  | { type: "tab"; operation: InspectorOperation }
  | { type: "back" | "forward" | "reset" };

/** Search query, cursor and results live outside this bounded inspector history. */
export function navigateInspector(state: InspectorNavigation, action: NavigationAction): InspectorNavigation {
  if (action.type === "reset") return emptyNavigation;
  if (action.type === "select") {
    if (!action.root && state.current?.symbol.id === action.symbol.id) return state;
    return { current: { symbol: action.symbol, operation: "source" }, back: action.root ? [] : [...state.back, ...(state.current ? [state.current] : [])].slice(-24), forward: [] };
  }
  if (action.type === "tab") return state.current ? { ...state, current: { ...state.current, operation: action.operation } } : state;
  if (action.type === "back" && state.back.length) return { current: state.back.at(-1)!, back: state.back.slice(0, -1), forward: [...(state.current ? [state.current] : []), ...state.forward].slice(0, 24) };
  if (action.type === "forward" && state.forward.length) return { current: state.forward[0], back: [...state.back, ...(state.current ? [state.current] : [])].slice(-24), forward: state.forward.slice(1) };
  return state;
}
