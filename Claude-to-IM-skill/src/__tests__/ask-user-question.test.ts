/**
 * Unit tests for extractSingleSelectQuestion — the AskUserQuestion parser that
 * decides whether a tool call is rendered as an option-button card or falls
 * back to the normal permission path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractSingleSelectQuestion } from '../llm-provider.js';

describe('extractSingleSelectQuestion', () => {
  it('extracts a single-select question into a flat option list', () => {
    const result = extractSingleSelectQuestion({
      questions: [{
        question: 'Which database?',
        header: 'Database',
        options: [
          { label: 'PostgreSQL', description: 'Relational' },
          { label: 'SQLite', description: 'Embedded' },
        ],
      }],
    });

    assert.ok(result);
    assert.equal(result!.questionText, 'Which database?');
    assert.deepEqual(result!.choices, [
      { index: 1, label: 'PostgreSQL', description: 'Relational' },
      { index: 2, label: 'SQLite', description: 'Embedded' },
    ]);
  });

  it('falls back to the header when the question text is missing', () => {
    const result = extractSingleSelectQuestion({
      questions: [{
        header: 'Pick a mode',
        options: [{ label: 'A' }, { label: 'B' }],
      }],
    });
    assert.ok(result);
    assert.equal(result!.questionText, 'Pick a mode');
  });

  it('returns null for multiSelect questions (text downgrade)', () => {
    const result = extractSingleSelectQuestion({
      questions: [{
        question: 'Pick features',
        multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }],
      }],
    });
    assert.equal(result, null);
  });

  it('returns null when there are fewer than two valid options', () => {
    assert.equal(
      extractSingleSelectQuestion({ questions: [{ question: 'Q', options: [{ label: 'Only' }] }] }),
      null,
    );
    assert.equal(
      extractSingleSelectQuestion({ questions: [{ question: 'Q', options: [{ label: 'A' }, { label: '' }] }] }),
      null,
    );
  });

  it('returns null for malformed or empty input', () => {
    assert.equal(extractSingleSelectQuestion({}), null);
    assert.equal(extractSingleSelectQuestion({ questions: [] }), null);
    assert.equal(extractSingleSelectQuestion({ questions: 'nope' as unknown as [] }), null);
  });
});
