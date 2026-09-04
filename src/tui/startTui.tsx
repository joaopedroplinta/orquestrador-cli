import { render } from "ink";
import App from "./App.js";

export async function startTui(): Promise<void> {
  // Redesenha só as linhas que mudaram em vez da árvore inteira a cada tecla —
  // reduz bastante o volume de bytes escritos no terminal por frame.
  const { waitUntilExit } = render(<App />, { incrementalRendering: true });
  await waitUntilExit();
}
