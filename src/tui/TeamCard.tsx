import { Box, Text } from "ink";
import type { TeamState } from "../team/coordinator.js";
import { agentColor } from "./agentColors.js";

const teamColor: Record<TeamState["status"], string> = {
  planning: "yellow", running: "cyan", integrating: "yellow", completed: "green",
  partial: "yellow", failed: "red", cancelled: "gray", conflict: "red",
};

const taskIcon: Record<TeamState["tasks"][number]["status"], string> = {
  pending: "○", running: "●", completed: "✓", failed: "✕", blocked: "⊘", cancelled: "■",
};

export default function TeamCard({ state }: { state: TeamState }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={teamColor[state.status]} paddingX={1} marginTop={1}>
      <Text bold color={teamColor[state.status]}>☍ Equipe {state.id.slice(0, 8)} · {state.status}</Text>
      <Text>{state.task}</Text>
      <Box flexDirection="column" marginTop={1}>
        {state.tasks.map((task) => (
          <Box key={task.id} flexDirection="column">
            <Text>
              <Text color={task.status === "completed" ? "green" : task.status === "failed" || task.status === "blocked" ? "red" : "yellow"}>{taskIcon[task.status]}</Text>{" "}
              <Text bold>{task.id.padEnd(14)}</Text><Text color={agentColor(task.agent)}>{task.agent}</Text>
              {task.dependsOn.length > 0 && <Text dimColor> · depende de {task.dependsOn.join(", ")}</Text>}
            </Text>
            {task.error && <Text color="red">  ↳ {task.error}</Text>}
          </Box>
        ))}
      </Box>
      {state.integration && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Integração: {state.integration.branch}</Text>
          <Text dimColor>Worktree: {state.integration.worktree}</Text>
          {state.integration.conflictTask && <Text color="red">Conflito: {state.integration.conflictTask}</Text>}
        </Box>
      )}
      {state.error && <Text color="red">Erro: {state.error}</Text>}
    </Box>
  );
}
