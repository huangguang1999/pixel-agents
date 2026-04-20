import { describe, expect, it } from 'vitest';

import { LIBRARY_TOOLS } from '../hooks/agentEventDispatch.js';
import { isReadingTool } from '../office/engine/characters.js';

/**
 * LIBRARY_TOOLS (dispatch layer) and READING_TOOLS (animation layer) must
 * agree: if dispatch routes a tool to the library, the character renderer
 * must also pick the reading sprite — otherwise the agent walks to a
 * bookshelf and then plays the typing animation.
 */
describe('LIBRARY_TOOLS ⇄ reading animation consistency', () => {
  it('every library tool plays the reading animation', () => {
    for (const tool of LIBRARY_TOOLS) {
      expect(isReadingTool(tool), `${tool} should be a reading tool`).toBe(true);
    }
  });

  it('contains the canonical set of lookup tools', () => {
    const expected = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];
    for (const tool of expected) {
      expect(LIBRARY_TOOLS.has(tool), `LIBRARY_TOOLS missing ${tool}`).toBe(true);
    }
  });

  it('does not include write-family tools', () => {
    for (const tool of ['Edit', 'Write', 'Bash', 'NotebookEdit']) {
      expect(LIBRARY_TOOLS.has(tool), `LIBRARY_TOOLS should not contain ${tool}`).toBe(false);
      expect(isReadingTool(tool), `${tool} should not be a reading tool`).toBe(false);
    }
  });

  it('isReadingTool(null) is false', () => {
    expect(isReadingTool(null)).toBe(false);
  });
});
