import {Box, Text} from 'ink';
import type {Line} from './grid.ts';

/** Grid lines as Ink text, one row each. */
export function Lines({lines, indent = 0}: {lines: Line[]; indent?: number}) {
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {' '.repeat(indent)}
          {l.map((s, k) => (
            <Text key={k} color={s.color} backgroundColor={s.bg} bold={s.bold}>
              {s.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}
