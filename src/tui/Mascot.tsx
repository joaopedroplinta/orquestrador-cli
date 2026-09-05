import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { MASCOT_BANNER_LINES, mascotThinkingFrame } from "./mascot.js";

// Índices de MASCOT_BANNER_LINES que ganham destaque amarelo (bico e pés) —
// puramente visual, por isso fica aqui e não em mascot.ts (que só guarda o
// que precisa ser testável).
const ACCENT_LINE_INDEXES = new Set([2, 4]);

export function MascotBanner() {
  return (
    <Box flexDirection="column">
      {MASCOT_BANNER_LINES.map((line, i) => (
        <Text key={i} color={ACCENT_LINE_INDEXES.has(i) ? "yellow" : undefined}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

const MASCOT_TICK_MS = 400;

// Substitui o <Spinner type="dots" /> do ink-spinner quando o mascote está
// ligado — mesma ideia (texto reciclando num intervalo), frames diferentes.
// 400ms por frame é mais lento que o dots padrão (~80ms) e o mesmo tipo de
// atualização periódica que o contador de segundos já faz (1000ms), então
// não é uma categoria de risco nova pro bug de EIO (ver CLAUDE.md bug #3) —
// ainda assim, validado com PTY real antes de mergear.
export function MascotSpinner() {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), MASCOT_TICK_MS);
    return () => clearInterval(interval);
  }, []);

  return <Text color="yellow">{mascotThinkingFrame(tick)}</Text>;
}
