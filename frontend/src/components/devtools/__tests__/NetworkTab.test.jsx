import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NetworkTab } from '../NetworkTab';

describe('NetworkTab', () => {
  const mockRequests = [
    {
      method: 'GET',
      url: '/api/users',
      status: 200,
      statusText: 'OK',
      contentType: 'application/json',
      responseSize: 1024,
      duration: 50,
      timestamp: Date.now(),
      requestHeaders: { 'Accept': 'application/json' },
      responseHeaders: { 'Content-Type': 'application/json' },
      responseBody: '{"users": []}'
    },
    {
      method: 'POST',
      url: '/api/users',
      status: 201,
      statusText: 'Created',
      contentType: 'application/json',
      responseSize: 512,
      duration: 100,
      timestamp: Date.now() + 100,
      requestHeaders: { 'Content-Type': 'application/json' },
      responseHeaders: { 'Content-Type': 'application/json' },
      requestBody: '{"name": "John"}',
      responseBody: '{"id": 1, "name": "John"}'
    },
    {
      method: 'GET',
      url: '/style.css',
      status: 200,
      statusText: 'OK',
      contentType: 'text/css',
      responseSize: 2048,
      duration: 30,
      timestamp: Date.now() + 200
    },
    {
      method: 'GET',
      url: '/script.js',
      status: 404,
      statusText: 'Not Found',
      contentType: 'text/html',
      responseSize: 256,
      duration: 20,
      timestamp: Date.now() + 300
    }
  ];

  let mockOnClear;

  beforeEach(() => {
    mockOnClear = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should render network requests table', () => {
    render(<NetworkTab requests={mockRequests} onClear={mockOnClear} />);

    expect(screen.getAllByText('GET').length).toBeGreaterThan(0);
    expect(screen.getAllByText('/api/users')).toHaveLength(2);
    expect(screen.getAllByText('200').length).toBeGreaterThan(0);
  });

  it('should filter requests by type', () => {
    render(<NetworkTab requests={mockRequests} onClear={mockOnClear} />);

    // Click on "Fetch/XHR" filter
    const fetchFilter = screen.getByText('Fetch/XHR');
    fireEvent.click(fetchFilter);

    // Should show POST request (JSON)
    expect(screen.getByText('POST')).toBeInTheDocument();
    // CSS should be filtered out
    expect(screen.queryByText('/style.css')).not.toBeInTheDocument();
  });

  it('should show request details when clicked', () => {
    render(<NetworkTab requests={mockRequests} onClear={mockOnClear} />);

    // Click on first request
    const firstRow = screen.getAllByText('/api/users')[0].closest('tr');
    fireEvent.click(firstRow);

    // Should show details tabs
    expect(screen.getByText('Headers')).toBeInTheDocument();
    expect(screen.getByText('Request')).toBeInTheDocument();
    expect(screen.getByText('Response')).toBeInTheDocument();
  });

  it('should export HAR file', () => {
    // Mock URL.createObjectURL
    vi.spyOn(global.URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(global.URL, 'revokeObjectURL').mockImplementation(() => {});

    // Mock createElement and click
    const mockLink = { href: '', download: '', click: vi.fn() };
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      if (tag === 'a') return mockLink;
      return originalCreateElement(tag);
    });

    render(<NetworkTab requests={mockRequests} onClear={mockOnClear} />);

    const harButton = screen.getByText('📥 HAR');
    fireEvent.click(harButton);

    expect(mockLink.click).toHaveBeenCalled();
    expect(mockLink.download).toMatch(/network-\d+\.har/);
  });

  it('should clear network log', () => {
    render(<NetworkTab requests={mockRequests} onClear={mockOnClear} />);

    const clearButton = screen.getByTitle('Clear network log');
    fireEvent.click(clearButton);

    expect(mockOnClear).toHaveBeenCalled();
  });

  it('should search requests by URL', () => {
    render(<NetworkTab requests={mockRequests} onClear={mockOnClear} />);

    const searchInput = screen.getByPlaceholderText('Filter requests...');
    fireEvent.change(searchInput, { target: { value: 'api' } });

    // Should show API requests
    expect(screen.getAllByText('/api/users')).toHaveLength(2);
    // Should not show non-API requests
    expect(screen.queryByText('/style.css')).not.toBeInTheDocument();
  });

  it('should color-code status correctly', () => {
    render(<NetworkTab requests={mockRequests} onClear={mockOnClear} />);

    const successCell = screen.getAllByText('200')[0].closest('td');
    expect(successCell).toHaveClass('status-success');

    const errorCell = screen.getByText('404').closest('td');
    expect(errorCell).toHaveClass('status-error');
  });

  it('should count requests by type', () => {
    render(<NetworkTab requests={mockRequests} onClear={mockOnClear} />);

    // All requests
    expect(screen.getByText('All')).toBeInTheDocument();
    // 2 Fetch/XHR requests (JSON content)
    const fetchFilter = screen.getByText('Fetch/XHR').closest('button');
    expect(fetchFilter.textContent).toContain('2');
  });

  it('should handle empty requests', () => {
    render(<NetworkTab requests={[]} onClear={mockOnClear} />);

    expect(screen.getByText('No requests recorded')).toBeInTheDocument();
  });

  it('should format request size correctly', () => {
    render(<NetworkTab requests={mockRequests} onClear={mockOnClear} />);

    // 1024 bytes = 1 KB
    expect(screen.getByText('1.0 KB')).toBeInTheDocument();
    // 2048 bytes = 2 KB
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
  });

  it('should format duration correctly', () => {
    render(<NetworkTab requests={mockRequests} onClear={mockOnClear} />);

    expect(screen.getByText('50 ms')).toBeInTheDocument();
    expect(screen.getByText('100 ms')).toBeInTheDocument();
  });
});
