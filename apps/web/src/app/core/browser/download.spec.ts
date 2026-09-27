import { copyText } from './clipboard';
import { downloadText } from './download';

describe('downloadText / copyText', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates a text Blob, clicks a temporary <a download> on a blob: URL, removes it and revokes the URL', async () => {
    vi.useFakeTimers();
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:http://localhost/1';
    });
    URL.revokeObjectURL = vi.fn();
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this);
    });

    downloadText(document, 'codes.txt', 'AAAAA-BBBBB\n');

    expect(blobs[0]?.type).toBe('text/plain;charset=utf-8');
    expect(await blobs[0]?.text()).toBe('AAAAA-BBBBB\n');
    expect(clicks[0]?.download).toBe('codes.txt');
    expect(clicks[0]?.href).toBe('blob:http://localhost/1');
    expect(document.querySelector('a[download]')).toBeNull();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/1');
    vi.useRealTimers();
  });

  it('copyText resolves true on success and false when the Clipboard API is missing or refuses', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    expect(await copyText('x', { clipboard: { writeText } as unknown as Clipboard })).toBe(true);
    expect(writeText).toHaveBeenCalledWith('x');
    expect(await copyText('x', { clipboard: undefined as unknown as Clipboard })).toBe(false);
    const refuse = vi.fn(() => Promise.reject(new Error('denied')));
    expect(await copyText('x', { clipboard: { writeText: refuse } as unknown as Clipboard })).toBe(false);
  });
});
