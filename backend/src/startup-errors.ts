export function formatStartupErrorMessage(error: unknown): string {
  if (isPortInUseError(error)) {
    const address = error.address || 'the configured host';
    return `Port ${error.port} is already in use on ${address}. Stop the existing process or set PORT to a different value.`;
  }

  return 'Failed to start server';
}

function isPortInUseError(
  error: unknown
): error is { code: string; port: number; address?: string } {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EADDRINUSE' &&
    'port' in error &&
    typeof (error as { port?: unknown }).port === 'number'
  );
}
