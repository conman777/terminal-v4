import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StorageTab } from '../StorageTab';

describe('StorageTab', () => {
  const mockStorage = {
    localStorage: {
      'user_id': '12345',
      'theme': 'dark',
      'language': 'en'
    },
    sessionStorage: {
      'cart_items': '[{"id": 1}]',
      'temp_data': 'test'
    },
    cookies: {
      'session': 'abc123'
    }
  };

  let mockOnUpdateStorage;

  beforeEach(() => {
    mockOnUpdateStorage = vi.fn().mockResolvedValue(undefined);
    // Mock window.confirm
    global.confirm = vi.fn(() => true);
    global.alert = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should render storage tree', () => {
    render(<StorageTab storage={mockStorage} onUpdateStorage={mockOnUpdateStorage} />);

    expect(screen.getByText('Local Storage')).toBeInTheDocument();
    expect(screen.getByText('Session Storage')).toBeInTheDocument();
    expect(screen.getByText('Cookies')).toBeInTheDocument();
  });

  it('should show storage counts', () => {
    render(<StorageTab storage={mockStorage} onUpdateStorage={mockOnUpdateStorage} />);

    const localStorageButton = screen.getByText('Local Storage').closest('button');
    expect(localStorageButton.textContent).toContain('(3)');

    const sessionStorageButton = screen.getByText('Session Storage').closest('button');
    expect(sessionStorageButton.textContent).toContain('(2)');
  });

  it('should display localStorage items by default', () => {
    render(<StorageTab storage={mockStorage} onUpdateStorage={mockOnUpdateStorage} />);

    expect(screen.getByText('user_id')).toBeInTheDocument();
    expect(screen.getByText('12345')).toBeInTheDocument();
    expect(screen.getByText('theme')).toBeInTheDocument();
    expect(screen.getByText('dark')).toBeInTheDocument();
  });

  it('should switch to sessionStorage when clicked', () => {
    render(<StorageTab storage={mockStorage} onUpdateStorage={mockOnUpdateStorage} />);

    const sessionStorageButton = screen.getByText('Session Storage');
    fireEvent.click(sessionStorageButton);

    expect(screen.getByText('cart_items')).toBeInTheDocument();
    expect(screen.getByText('temp_data')).toBeInTheDocument();
  });

  it('should search storage items', () => {
    render(<StorageTab storage={mockStorage} onUpdateStorage={mockOnUpdateStorage} />);

    const searchInput = screen.getByPlaceholderText('Search storage...');
    fireEvent.change(searchInput, { target: { value: 'theme' } });

    expect(screen.getByText('theme')).toBeInTheDocument();
    expect(screen.queryByText('user_id')).not.toBeInTheDocument();
  });

  it('should show add form when add button clicked', () => {
    render(<StorageTab storage={mockStorage} onUpdateStorage={mockOnUpdateStorage} />);

    const addButton = screen.getByTitle('Add new item');
    fireEvent.click(addButton);

    expect(screen.getByPlaceholderText('Key')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Value')).toBeInTheDocument();
  });

  it('should add new storage item', async () => {
    render(<StorageTab storage={mockStorage} onUpdateStorage={mockOnUpdateStorage} />);

    const addButton = screen.getByTitle('Add new item');
    fireEvent.click(addButton);

    const keyInput = screen.getByPlaceholderText('Key');
    const valueInput = screen.getByPlaceholderText('Value');

    fireEvent.change(keyInput, { target: { value: 'new_key' } });
    fireEvent.change(valueInput, { target: { value: 'new_value' } });

    const submitButton = screen.getByText('Add');
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockOnUpdateStorage).toHaveBeenCalledWith('localStorage', 'set', 'new_key', 'new_value');
    });
  });

  it('should edit storage item', async () => {
    render(<StorageTab storage={mockStorage} onUpdateStorage={mockOnUpdateStorage} />);

    // Find edit button for 'theme' entry
    const themeRow = screen.getByText('theme').closest('tr');
    const editButton = themeRow.querySelector('[title="Edit"]');
    fireEvent.click(editButton);

    // Input should appear
    const editInput = themeRow.querySelector('input.edit-input');
    expect(editInput).toBeInTheDocument();

    // Change value
    fireEvent.change(editInput, { target: { value: 'light' } });

    // Click save
    const saveButton = themeRow.querySelector('[title="Save"]');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockOnUpdateStorage).toHaveBeenCalledWith('localStorage', 'set', 'theme', 'light');
    });
  });

  it('should delete storage item', async () => {
    render(<StorageTab storage={mockStorage} onUpdateStorage={mockOnUpdateStorage} />);

    // Find delete button for 'theme' entry
    const themeRow = screen.getByText('theme').closest('tr');
    const deleteButton = themeRow.querySelector('[title="Delete"]');
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(mockOnUpdateStorage).toHaveBeenCalledWith('localStorage', 'remove', 'theme');
    });

    expect(global.confirm).toHaveBeenCalledWith('Delete "theme"?');
  });

  it('should clear all storage items', async () => {
    render(<StorageTab storage={mockStorage} onUpdateStorage={mockOnUpdateStorage} />);

    const clearButton = screen.getByTitle('Clear all');
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(mockOnUpdateStorage).toHaveBeenCalledWith('localStorage', 'clear');
    });

    expect(global.confirm).toHaveBeenCalledWith('Clear all localStorage items?');
  });

  it('should export storage data', () => {
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

    render(<StorageTab storage={mockStorage} onUpdateStorage={mockOnUpdateStorage} />);

    const exportButton = screen.getByTitle('Export storage');
    fireEvent.click(exportButton);

    expect(mockLink.click).toHaveBeenCalled();
    expect(mockLink.download).toMatch(/localStorage-\d+\.json/);
  });

  it('should import storage data', async () => {
    const mockFile = {
      size: 128,
      text: vi.fn().mockResolvedValue(
        JSON.stringify({ type: 'localStorage', data: { imported_key: 'imported_value' } })
      )
    };

    render(<StorageTab storage={mockStorage} onUpdateStorage={mockOnUpdateStorage} />);

    const importLabel = screen.getByTitle('Import storage');
    const fileInput = importLabel.querySelector('input[type="file"]');

    // Trigger file selection
    Object.defineProperty(fileInput, 'files', {
      value: [mockFile],
      writable: false
    });
    fireEvent.change(fileInput);

    await waitFor(() => {
      expect(mockOnUpdateStorage).toHaveBeenCalledWith(
        'localStorage',
        'set',
        'imported_key',
        'imported_value'
      );
    });
  });

  it('should handle empty storage', () => {
    render(<StorageTab storage={{ localStorage: {}, sessionStorage: {}, cookies: {} }} />);

    expect(screen.getByText('No localStorage items')).toBeInTheDocument();
  });

  it('should cancel edit when Escape is pressed', () => {
    render(<StorageTab storage={mockStorage} onUpdateStorage={mockOnUpdateStorage} />);

    // Start editing
    const themeRow = screen.getByText('theme').closest('tr');
    const editButton = themeRow.querySelector('[title="Edit"]');
    fireEvent.click(editButton);

    // Input should appear
    const editInput = themeRow.querySelector('input.edit-input');
    expect(editInput).toBeInTheDocument();

    // Press Escape
    fireEvent.keyDown(editInput, { key: 'Escape', code: 'Escape' });

    // Input should disappear
    expect(themeRow.querySelector('input.edit-input')).not.toBeInTheDocument();
  });

  it('should save edit when Enter is pressed', async () => {
    render(<StorageTab storage={mockStorage} onUpdateStorage={mockOnUpdateStorage} />);

    // Start editing
    const themeRow = screen.getByText('theme').closest('tr');
    const editButton = themeRow.querySelector('[title="Edit"]');
    fireEvent.click(editButton);

    // Input should appear
    const editInput = themeRow.querySelector('input.edit-input');
    fireEvent.change(editInput, { target: { value: 'light' } });

    // Press Enter
    fireEvent.keyDown(editInput, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(mockOnUpdateStorage).toHaveBeenCalledWith('localStorage', 'set', 'theme', 'light');
    });
  });
});
