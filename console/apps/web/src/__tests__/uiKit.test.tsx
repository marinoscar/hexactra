// The console's UI kit (apps/web/src/ui): the page header, the confirm dialog,
// the status chip, the responsive list and the small states.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import AddIcon from '@mui/icons-material/Add';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

import { RUN_STATUSES, RUN_STOP_REASONS } from '../types/runs';
import {
  CardSkeleton,
  ConfirmProvider,
  EmptyState,
  ErrorBanner,
  ListSkeleton,
  PageContainer,
  PageHeader,
  ResponsiveList,
  STOP_REASON_LABEL,
  StatusChip,
  formatCost,
  isLive,
  isTerminal,
  statusLabel,
  stopReasonLabel,
  useApiAction,
  useBreakpoint,
  useConfirm,
  type Column,
  type ConfirmOptions,
  type PageAction,
} from '../ui';
import { mockViewport } from './matchMedia';

let restoreViewport: (() => void) | null = null;
const viewport = (width: number) => {
  restoreViewport = mockViewport(width);
};
afterEach(() => {
  restoreViewport?.();
  restoreViewport = null;
});

describe('useBreakpoint', () => {
  it.each([
    [390, { isPhone: true, isTablet: false, isDesktop: false }],
    [768, { isPhone: false, isTablet: true, isDesktop: false }],
    [1440, { isPhone: false, isTablet: false, isDesktop: true }],
  ])('reads %i px', (width, expected) => {
    viewport(width);
    expect(renderHook(() => useBreakpoint()).result.current).toEqual(expected);
  });

  it('reads a window without matchMedia as a desktop', () => {
    expect(renderHook(() => useBreakpoint()).result.current).toEqual({ isPhone: false, isTablet: false, isDesktop: true });
  });
});

describe('PageHeader', () => {
  const onExport = vi.fn();
  const onCreate = vi.fn();
  const actions: PageAction[] = [
    { key: 'export', label: 'Export', onClick: onExport },
    { key: 'policies', label: 'Policies', to: '/settings/agent-policies' },
    { key: 'secret', label: 'Hidden one', onClick: () => undefined, hidden: true },
  ];
  const header = (primary: PageAction) =>
    render(
      <MemoryRouter>
        <PageHeader title="Tasks" subtitle="Saved goals" back={{ to: '/', label: 'Home' }} actions={actions} primary={primary} />
      </MemoryRouter>,
    );
  beforeEach(() => {
    onExport.mockClear();
    onCreate.mockClear();
  });

  it('shows the title as the h1, a real back link, and every action as a button from sm up', () => {
    viewport(1440);
    header({ key: 'new', label: 'New task', Icon: AddIcon, onClick: onCreate });
    expect(screen.getByRole('heading', { level: 1, name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getByText('Saved goals')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Home/ })).toHaveAttribute('href', '/');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Policies' })).toHaveAttribute('href', '/settings/agent-policies');
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
    expect(screen.queryByText('Hidden one')).not.toBeInTheDocument();
  });

  it('collapses the secondary actions into one More menu below sm, keeping a short primary as an icon button', async () => {
    viewport(390);
    header({ key: 'new', label: 'New task', Icon: AddIcon, onClick: onCreate });
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
    // The primary stays visible: an icon button named by its label.
    const primary = screen.getByRole('button', { name: 'New task' });
    expect(primary).not.toHaveTextContent('New task');
    fireEvent.click(primary);
    expect(onCreate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Policies' })).toHaveAttribute('href', '/settings/agent-policies');
    expect(within(menu).queryByText('Hidden one')).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Export' }));
    expect(onExport).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('puts a primary with a long label full-width under the title below sm', () => {
    viewport(390);
    header({ key: 'new', label: 'Create a new task', Icon: AddIcon, onClick: onCreate });
    const primary = screen.getByRole('button', { name: 'Create a new task' });
    expect(primary).toHaveTextContent('Create a new task');
    expect(primary.className).toMatch(/fullWidth/);
  });

  it('renders no More button without secondary actions, and no primary when it is hidden', () => {
    viewport(390);
    render(
      <MemoryRouter>
        <PageHeader title="Fleet" primary={{ key: 'enroll', label: 'Enroll host', Icon: AddIcon, onClick: onCreate, hidden: true }} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('PageContainer', () => {
  it.each([
    ['narrow', 'Sm'],
    ['default', 'Md'],
    ['wide', 'Lg'],
  ] as const)('%s is maxWidth %s', (width, suffix) => {
    const { container } = render(
      <PageContainer width={width}>
        <p>content</p>
      </PageContainer>,
    );
    expect(container.firstElementChild?.className).toContain(`MuiContainer-maxWidth${suffix}`);
  });
});

describe('StatusChip', () => {
  it.each(RUN_STATUSES)('renders a label and an icon for %s', (status) => {
    render(<StatusChip status={status} />);
    expect(screen.getByText(status === 'waiting_human' ? 'needs you' : status)).toBeInTheDocument();
    expect(screen.getByTestId(`status-icon-${status}`)).toBeInTheDocument();
  });

  it('renders an unknown status as a default chip with the raw text', () => {
    const { container } = render(<StatusChip status="paused_by_policy" />);
    expect(screen.getByText('paused_by_policy')).toBeInTheDocument();
    expect(container.querySelector('.MuiChip-colorDefault')).not.toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('appends a budget or stall stop in words, and an unknown reason as raw text', () => {
    const { rerender } = render(<StatusChip status="failed" stopReason="budget_cost" />);
    expect(screen.getByText('failed · cost budget')).toBeInTheDocument();
    rerender(<StatusChip status="failed" stopReason="stalled" />);
    expect(screen.getByText('failed · stalled')).toBeInTheDocument();
    rerender(<StatusChip status="failed" stopReason="quota_exhausted" />);
    expect(screen.getByText('failed · quota_exhausted')).toBeInTheDocument();
    // The other reasons repeat the status.
    rerender(<StatusChip status="failed" stopReason="error" />);
    expect(screen.getByText('failed')).toBeInTheDocument();
    rerender(<StatusChip status="succeeded" stopReason="finished" />);
    expect(screen.getByText('succeeded')).toBeInTheDocument();
    rerender(<StatusChip status="running" stopReason={null} />);
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('has a label for every stop reason of the API', () => {
    // The API's enum (`RUN_STOP_REASONS`), read from its source: the web cannot import the API.
    const source = readFileSync(join(process.cwd(), '..', 'api', 'src', 'runner', 'budget.ts'), 'utf8');
    const block = /export const RUN_STOP_REASONS = \[([^\]]+)\]/.exec(source);
    expect(block).not.toBeNull();
    const reasons = [...block![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(reasons.length).toBeGreaterThanOrEqual(11);
    for (const reason of reasons) {
      expect(STOP_REASON_LABEL, `no label for ${reason}`).toHaveProperty(reason);
      expect(stopReasonLabel(reason)).not.toBe('');
    }
    expect([...RUN_STOP_REASONS].sort()).toEqual([...reasons].sort());
    expect(Object.keys(STOP_REASON_LABEL).sort()).toEqual([...reasons].sort());
    expect(stopReasonLabel('something_new')).toBe('something_new');
  });

  it('tells live from terminal statuses', () => {
    expect(RUN_STATUSES.filter(isLive)).toEqual(['queued', 'running', 'waiting_human', 'paused']);
    expect(RUN_STATUSES.filter(isTerminal)).toEqual(['succeeded', 'failed', 'cancelled']);
    expect(isLive('something_new')).toBe(false);
    expect(isTerminal('something_new')).toBe(false);
    expect(statusLabel('waiting_human')).toBe('needs you');
  });
});

describe('formatCost', () => {
  it('covers known, unknown, tiny and null', () => {
    expect(formatCost(4.2, true)).toBe('$4.20');
    expect(formatCost(4.2)).toBe('$4.20');
    expect(formatCost(1234.5, true)).toBe('$1,234.50');
    expect(formatCost(4.2, false)).toBe('≥ $4.20');
    expect(formatCost(0.004, true)).toBe('<$0.01');
    expect(formatCost(0.004, false)).toBe('≥ $0.00');
    expect(formatCost(0, true)).toBe('$0.00');
    expect(formatCost(null, true)).toBeNull();
    expect(formatCost(undefined, false)).toBeNull();
    expect(formatCost(Number.NaN, true)).toBeNull();
  });
});

describe('ConfirmDialog and useConfirm', () => {
  function Asker({ options, onAnswer }: { options: ConfirmOptions; onAnswer: (answer: boolean) => void }) {
    const confirm = useConfirm();
    return <button onClick={() => void confirm(options).then(onAnswer)}>ask</button>;
  }
  const ask = (options: ConfirmOptions) => {
    const onAnswer = vi.fn();
    render(
      <ConfirmProvider>
        <Asker options={options} onAnswer={onAnswer} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    return onAnswer;
  };

  it('resolves true on confirm', async () => {
    const onAnswer = ask({ title: 'Send it?', body: 'The message goes out.', confirmLabel: 'Send' });
    const dialog = await screen.findByRole('dialog', { name: 'Send it?' });
    expect(within(dialog).getByText('The message goes out.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('resolves false on Cancel', async () => {
    const onAnswer = ask({ title: 'Send it?' });
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(false));
  });

  it('resolves false on Escape', async () => {
    const onAnswer = ask({ title: 'Send it?' });
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(false));
  });

  it('resolves false on a backdrop click', async () => {
    const onAnswer = ask({ title: 'Send it?' });
    await screen.findByRole('dialog');
    fireEvent.click(document.querySelector('.MuiBackdrop-root')!);
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(false));
  });

  it('colours a destructive confirm button as an error and starts focus on Cancel', async () => {
    ask({ title: 'Delete it?', confirmLabel: 'Delete', destructive: true });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Delete' }).className).toMatch(/colorError/);
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus());
  });

  it('starts focus on the confirm button when the action is not destructive', async () => {
    ask({ title: 'Send it?', confirmLabel: 'Send' });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Send' }).className).not.toMatch(/colorError/);
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Send' })).toHaveFocus());
  });

  it('enforces requireText: the confirm button enables only once the word is typed', async () => {
    const onAnswer = ask({ title: 'Delete 1,240 runs?', confirmLabel: 'Delete runs', destructive: true, requireText: 'delete' });
    const dialog = await screen.findByRole('dialog');
    const button = within(dialog).getByRole('button', { name: 'Delete runs' });
    const field = within(dialog).getByLabelText('Type “delete” to confirm');
    expect(button).toBeDisabled();
    fireEvent.change(field, { target: { value: 'delet' } });
    expect(button).toBeDisabled();
    // Enter does nothing until the word matches.
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: 'delete' } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(true));
  });

  it('clears the typed word between two questions', async () => {
    const onAnswer = ask({ title: 'Delete runs?', confirmLabel: 'Delete runs', requireText: 'delete' });
    fireEvent.change(within(await screen.findByRole('dialog')).getByLabelText('Type “delete” to confirm'), { target: { value: 'delete' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(false));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    expect(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete runs' })).toBeDisabled();
  });

  it('answers a pending question false when another is asked, and when the provider unmounts', async () => {
    const answers: boolean[] = [];
    let confirm!: ReturnType<typeof useConfirm>;
    function Grab() {
      confirm = useConfirm();
      return null;
    }
    const { unmount } = render(
      <ConfirmProvider>
        <Grab />
      </ConfirmProvider>,
    );
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = confirm({ title: 'First?' });
    });
    act(() => {
      second = confirm({ title: 'Second?' });
    });
    void second.then((a) => answers.push(a));
    await expect(first).resolves.toBe(false);
    expect(await screen.findByRole('dialog', { name: 'Second?' })).toBeInTheDocument();
    unmount();
    await expect(second).resolves.toBe(false);
    expect(answers).toEqual([false]);
  });

  it('stacks the buttons and stays a normal dialog on a phone when the body fits', async () => {
    viewport(390);
    ask({ title: 'Delete it?', body: 'Short.', destructive: true });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.className).not.toMatch(/paperFullScreen/);
  });

  it('goes full-screen on a phone only when the body is taller than the viewport', async () => {
    viewport(390);
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(5_000);
    try {
      ask({ title: 'Delete it?', body: 'A very long explanation.', destructive: true });
      const dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(dialog.className).toMatch(/paperFullScreen/));
    } finally {
      height.mockRestore();
    }
  });

  it('never goes full-screen from sm up', async () => {
    viewport(1440);
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(5_000);
    try {
      ask({ title: 'Delete it?', body: 'A very long explanation.' });
      expect((await screen.findByRole('dialog')).className).not.toMatch(/paperFullScreen/);
    } finally {
      height.mockRestore();
    }
  });

  it('throws outside a ConfirmProvider', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useConfirm())).toThrow(/ConfirmProvider/);
    error.mockRestore();
  });
});

describe('ResponsiveList', () => {
  interface Row {
    id: string;
    name: string;
    steps: number;
  }
  const rows: Row[] = [
    { id: 'a', name: 'Check fare', steps: 12 },
    { id: 'b', name: 'Order groceries', steps: 3 },
  ];
  const columns: Column<Row>[] = [
    { key: 'name', header: 'Name', render: (r) => r.name },
    { key: 'steps', header: 'Steps', render: (r) => r.steps, align: 'right' },
    { key: 'id', header: 'Id', render: (r) => r.id, hideBelow: 'lg' },
  ];
  const list = (props: Partial<React.ComponentProps<typeof ResponsiveList<Row>>> = {}) =>
    render(
      <ResponsiveList
        aria-label="Rows"
        items={rows}
        columns={columns}
        getKey={(r) => r.id}
        getLabel={(r) => r.name}
        renderCard={(r) => <div data-testid="card">{r.name} card</div>}
        footer={<p>2 rows</p>}
        {...props}
      />,
    );

  it('renders a table at md and up', () => {
    viewport(1024);
    list();
    const table = screen.getByRole('table', { name: 'Rows' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Steps', 'Id']);
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByRole('cell', { name: '12' }).className).toMatch(/alignRight/);
    expect(table.className).toMatch(/stickyHeader/);
    expect(screen.queryByTestId('card')).not.toBeInTheDocument();
    expect(screen.getByText('2 rows')).toBeInTheDocument();
  });

  it('renders the cards below md', () => {
    viewport(768);
    list();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('card').map((c) => c.textContent)).toEqual(['Check fare card', 'Order groceries card']);
    expect(within(screen.getByRole('list', { name: 'Rows' })).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('2 rows')).toBeInTheDocument();
  });

  it('opens a row on click and on Enter, and rows are focusable', () => {
    viewport(1440);
    const onRowClick = vi.fn();
    list({ onRowClick });
    const row = screen.getByRole('row', { name: /Check fare/ });
    expect(row).toHaveAttribute('tabindex', '0');
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: 'a' });
    expect(onRowClick).toHaveBeenCalledTimes(2);
    expect(onRowClick).toHaveBeenLastCalledWith(rows[0]);
  });

  it('leaves rows out of the tab order without onRowClick', () => {
    viewport(1440);
    list();
    expect(screen.getByRole('row', { name: /Check fare/ })).not.toHaveAttribute('tabindex');
  });

  it('selects rows without opening them, in the table and in the cards', () => {
    viewport(1440);
    const onRowClick = vi.fn();
    const selection = { selected: new Set(['a']), onToggle: vi.fn(), onToggleAll: vi.fn() };
    const { unmount } = list({ onRowClick, selection });
    expect(screen.getByRole('checkbox', { name: 'Select Check fare' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Order groceries' }));
    expect(selection.onToggle).toHaveBeenCalledWith('b');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(selection.onToggleAll).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
    unmount();
    restoreViewport?.();
    viewport(390);
    list({ selection });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Order groceries' }));
    expect(selection.onToggle).toHaveBeenCalledTimes(2);
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('disables the checkbox of an item that cannot be selected, and does not count it towards "all selected"', () => {
    viewport(1440);
    const selection = { selected: new Set(['a']), onToggle: vi.fn(), onToggleAll: vi.fn(), disabledReason: (key: string) => (key === 'b' ? 'Cancel it first' : null) };
    list({ selection });
    expect(screen.getByRole('checkbox', { name: 'Select Order groceries' })).toBeDisabled();
    expect(screen.getByLabelText('Cancel it first')).toBeInTheDocument();
    // Every item that can be selected is: the header checkbox is checked, not indeterminate.
    expect(screen.getByRole('checkbox', { name: 'Select all' })).toBeChecked();
  });

  it('lets a marked column grow instead of the first', () => {
    viewport(1440);
    list({ columns: [columns[1]!, { ...columns[0]!, grow: true }] });
    const [steps, name] = screen.getAllByRole('columnheader');
    expect(name!.style.width || getComputedStyle(name!).width).toBe('100%');
    expect(getComputedStyle(steps!).width).not.toBe('100%');
  });

  it('windows a long table: a chunk far from the viewport is one spacer row of its measured height', () => {
    viewport(1440);
    const observers: { callback: IntersectionObserverCallback; target: Element | null }[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private readonly entry: { callback: IntersectionObserverCallback; target: Element | null };
        constructor(callback: IntersectionObserverCallback) {
          this.entry = { callback, target: null };
          observers.push(this.entry);
        }
        observe(target: Element) {
          this.entry.target = target;
        }
        disconnect() {}
      },
    );
    try {
      const many = Array.from({ length: 60 }, (_, i) => ({ id: `r${i}`, name: `Row ${i}`, steps: i }));
      list({ items: many, windowAfter: 50 });
      expect(observers).toHaveLength(3);
      expect(screen.getAllByRole('row')).toHaveLength(61);
      const fire = (index: number, isIntersecting: boolean) =>
        act(() => observers[index]!.callback([{ isIntersecting, boundingClientRect: { height: 1325 } } as IntersectionObserverEntry], {} as IntersectionObserver));
      fire(0, false);
      expect(screen.queryByText('Row 0')).not.toBeInTheDocument();
      expect(screen.getByText('Row 25')).toBeInTheDocument();
      expect((observers[0]!.target as HTMLElement).querySelector('tr')).toHaveStyle({ height: '1325px' });
      fire(0, true);
      expect(screen.getByText('Row 0')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not window a list at or under the threshold', () => {
    viewport(1440);
    const { container } = list({ windowAfter: 50 });
    expect(container.querySelectorAll('tbody')).toHaveLength(1);
  });
});

describe('EmptyState, ErrorBanner and the skeletons', () => {
  it('EmptyState shows its title, body and action', () => {
    const onClick = vi.fn();
    render(
      <MemoryRouter>
        <EmptyState title="No tasks yet" body="Create one to start." action={{ key: 'new', label: 'New task', onClick }} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('No tasks yet');
    expect(screen.getByText('Create one to start.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('EmptyState links its action when it has a destination', () => {
    render(
      <MemoryRouter>
        <EmptyState title="Nothing waiting" action={{ key: 'tasks', label: 'Open tasks', to: '/tasks' }} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Open tasks' })).toHaveAttribute('href', '/tasks');
  });

  it('ErrorBanner is an alert with retry and close, and renders nothing without an error', () => {
    const onRetry = vi.fn();
    const onClose = vi.fn();
    const { rerender, container } = render(<ErrorBanner error="Could not load" onRetry={onRetry} onClose={onClose} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<ErrorBanner error="Could not load" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<ErrorBanner error={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('the skeletons render the asked number of placeholders', () => {
    const { container, rerender } = render(<ListSkeleton rows={4} />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(container.querySelectorAll('.MuiSkeleton-root')).toHaveLength(4);
    rerender(<CardSkeleton rows={2} />);
    expect(container.querySelectorAll('.MuiCard-root')).toHaveLength(2);
  });
});

describe('useApiAction', () => {
  it('sets busy to the key while the action runs and returns its value', async () => {
    const { result } = renderHook(() => useApiAction());
    let release!: (value: string) => void;
    let pending!: Promise<string | undefined>;
    act(() => {
      pending = result.current.run('save', () => new Promise<string>((resolve) => (release = resolve)));
    });
    expect(result.current.busy).toBe('save');
    await act(async () => {
      release('done');
      await pending;
    });
    await expect(pending).resolves.toBe('done');
    expect(result.current.busy).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('catches a failure, stores its message and never rejects', async () => {
    const { result } = renderHook(() => useApiAction());
    let value: unknown = 'unset';
    await act(async () => {
      value = await result.current.run('delete', async () => {
        throw new Error('The host is offline');
      });
    });
    expect(value).toBeUndefined();
    expect(result.current.error).toBe('The host is offline');
    expect(result.current.busy).toBeNull();
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it('uses the fallback for a failure without a message, and clears the error on the next run', async () => {
    const { result } = renderHook(() => useApiAction('Could not send the answer'));
    await act(async () => {
      await result.current.run('a', () => Promise.reject('nope'));
    });
    expect(result.current.error).toBe('Could not send the answer');
    await act(async () => {
      await result.current.run('b', () => Promise.reject(new Error('')), 'Could not save');
    });
    expect(result.current.error).toBe('Could not save');
    await act(async () => {
      await result.current.run('c', async () => 1);
    });
    expect(result.current.error).toBeNull();
  });
});
