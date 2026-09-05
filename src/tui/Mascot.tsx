import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { mascotThinkingFrame, selectMascotBannerLines } from "./mascot.js";

// Corpo em branco/cinza claro (contraste em fundo escuro OU claro) — o
// contorno da caixa do banner (Box borderColor="cyan" em App.tsx) continua
// com a cor padrão do projeto, sem mexer nela aqui.
const MASCOT_BODY_COLOR = "whiteBright";

export function MascotBanner() {
  const lines = selectMascotBannerLines(process.stdout.columns);
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} color={MASCOT_BODY_COLOR}>
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
