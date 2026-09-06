import { Box, Text } from "ink";
import { formatUsdCost, usageLine } from "../reporting.js";
import type { AgentRunResult } from "../types.js";
import { agentColor } from "./agentColors.js";
import OutputFormatter from "./OutputFormatter.js";

export interface StepCardProps {
  step: AgentRunResult;
  batchPrefix?: string;
  mascotFace?: string;
}

export default function StepCard({ step, batchPrefix = "", mascotFace }: StepCardProps) {
  const borderColor = agentColor(step.agent);
  const durationSec = (step.durationMs / 1000).toFixed(2);
  const usage = usageLine(step.usage);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginTop={1}
    >
      <Box justifyContent="space-between">
        <Box>
          {mascotFace && <Text>{mascotFace} </Text>}
          {batchPrefix.length > 0 && <Text dimColor>{batchPrefix}</Text>}
          <Text bold color={borderColor}>
            [{step.agent}]
          </Text>
          <Text dimColor> ({durationSec}s)</Text>
          {step.retries && step.retries.length > 0 && (
            <Text color="yellow"> ⟳ {step.retries.length} {step.retries.length === 1 ? "retry" : "retries"}</Text>
          )}
        </Box>
        {step.usage?.costUsd !== undefined && (
          <Text color="green" bold>
            {formatUsdCost(step.usage.costUsd)}
          </Text>
        )}
      </Box>

      {usage && (
        <Box marginY={0}>
          <Text dimColor>{usage}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <OutputFormatter text={step.output} />
      </Box>
    </Box>
  );
}
