import { render } from "ink";
import type { AgentName, RoutingStrategy } from "../types.js";
import App from "./App.js";

export interface StartTuiOptions {
  /** Seed de ModeState.forcedAgent — vem do campo "agent" do .orquestradorrc, se houver. */
  initialForcedAgent?: AgentName;
  /** Seed de ModeState.routing — vem do campo "routing" do .orquestradorrc, se houver. */
  initialRouting?: RoutingStrategy;
  /** Seed de ModeState.autoMode — vem do campo "auto" do .orquestradorrc, se houver. */
  initialAutoMode?: boolean;
  /** Repassado direto pra todo runPipeline/runPipelines da sessão — vem do .orquestradorrc, sem slash command pra mudar em runtime. */
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export async function startTui(options: StartTuiOptions = {}): Promise<void> {
  // Redesenha só as linhas que mudaram em vez da árvore inteira a cada tecla —
  // reduz bastante o volume de bytes escritos no terminal por frame.
  const { waitUntilExit } = render(
    <App
      initialForcedAgent={options.initialForcedAgent}
      initialRouting={options.initialRouting}
      initialAutoMode={options.initialAutoMode}
      maxRetries={options.maxRetries}
      retryBaseDelayMs={options.retryBaseDelayMs}
    />,
    { incrementalRendering: true },
  );
  await waitUntilExit();
}
