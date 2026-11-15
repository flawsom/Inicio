// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api';
import { ImportConflictActions, importConflictFrom } from '../src/App';

/**
 * The conflict the upload path can actually act on.
 *
 * The API sends a sentence and, for `form_id_taken`, the id and name of the form that
 * owns the workbook's declared ID. The console must read those details rather than
 * scraping the sentence, and it must offer the two choices the refusal describes:
 * open the owning form, or import this workbook as a copy with a fresh ID.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

describe('the form-ID conflict notice', () => {
  it('reads the owning form from a form_id_taken payload', () => {
    const error = new ApiError(409, 'form_id_taken', 'already belongs to…', {
      error: 'form_id_taken',
      message: 'already belongs to…',
      details: { formId: 'form-1', formName: 'Household 2026', declaredFormId: 'household_2026' },
    });
    expect(importConflictFrom(error)).toEqual({ formId: 'form-1', formName: 'Household 2026' });
  });

  it('offers nothing when the refusal is not the actionable conflict', () => {
    expect(importConflictFrom(new ApiError(409, 'upload_refused', 'no version'))).toBeNull();
    expect(importConflictFrom(new Error('network'))).toBeNull();
    expect(
      importConflictFrom(
        new ApiError(409, 'form_id_taken', 'malformed', { details: { formId: 1, formName: null } }),
      ),
    ).toBeNull();
  });

  it('puts both actions in front of the reader and wires them', async () => {
    let opened = 0;
    let copied = 0;
    await act(async () => {
      root.render(
        <ImportConflictActions
          formName="Household 2026"
          onOpen={() => {
            opened += 1;
          }}
          onCopy={() => {
            copied += 1;
          }}
        />,
      );
    });

    expect(container.textContent).toContain('Open "Household 2026"');
    expect(container.textContent).toContain('Import as copy');

    const buttons = Array.from(container.querySelectorAll('button'));
    const open = buttons.find((button) => button.textContent === 'Open "Household 2026"');
    const copy = buttons.find((button) => button.textContent === 'Import as copy');
    expect(open, 'no Open button').toBeDefined();
    expect(copy, 'no Import as copy button').toBeDefined();

    await act(async () => {
      open!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(opened).toBe(1);
    expect(copied).toBe(0);
    await act(async () => {
      copy!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(copied).toBe(1);
    expect(opened).toBe(1);
  });
});
