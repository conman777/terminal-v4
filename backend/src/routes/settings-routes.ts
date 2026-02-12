import type { FastifyInstance } from 'fastify';
import { getDatabase } from '../database/db';

interface UserSettings {
  groqApiKey: string | null;
  openaiApiKey: string | null;
  previewUrl: string | null;
  terminalFontSize: number | null;
  sidebarCollapsed: boolean | null;
  terminalWebglEnabled: boolean | null;
  theme: string | null;
  tabOrder: string[] | null;
}

interface UpdateSettingsBody {
  groqApiKey?: string | null;
  openaiApiKey?: string | null;
  previewUrl?: string | null;
  terminalFontSize?: number | null;
  sidebarCollapsed?: boolean | null;
  terminalWebglEnabled?: boolean | null;
  theme?: string | null;
  tabOrder?: string[] | null;
}

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  // Get user settings
  app.get('/api/settings', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const db = getDatabase();
    const row = db.prepare('SELECT groq_api_key, openai_api_key, preview_url, terminal_font_size, sidebar_collapsed, terminal_webgl_enabled, theme, tab_order FROM user_settings WHERE user_id = ?').get(userId) as { groq_api_key: string | null; openai_api_key: string | null; preview_url: string | null; terminal_font_size: number | null; sidebar_collapsed: number | null; terminal_webgl_enabled: number | null; theme: string | null; tab_order: string | null } | undefined;

    // Mask the API key for display (show only last 4 chars)
    const groqApiKey = row?.groq_api_key;
    const maskedKey = groqApiKey ? `${'*'.repeat(Math.max(0, groqApiKey.length - 4))}${groqApiKey.slice(-4)}` : null;
    const openaiApiKey = row?.openai_api_key;
    const maskedOpenAIKey = openaiApiKey ? `${'*'.repeat(Math.max(0, openaiApiKey.length - 4))}${openaiApiKey.slice(-4)}` : null;

    let tabOrder: string[] | null = null;
    if (row?.tab_order) {
      try { tabOrder = JSON.parse(row.tab_order); } catch { tabOrder = null; }
    }

    return {
      groqApiKey: maskedKey,
      hasGroqApiKey: !!groqApiKey,
      openaiApiKey: maskedOpenAIKey,
      hasOpenAIApiKey: !!openaiApiKey,
      previewUrl: row?.preview_url || null,
      terminalFontSize: row?.terminal_font_size ?? null,
      sidebarCollapsed: row?.sidebar_collapsed === 1,
      terminalWebglEnabled: row?.terminal_webgl_enabled === null || row?.terminal_webgl_enabled === undefined
        ? null
        : row?.terminal_webgl_enabled === 1,
      theme: row?.theme || 'dark',
      tabOrder
    };
  });

  // Update user settings
  app.patch<{ Body: UpdateSettingsBody }>('/api/settings', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const { groqApiKey, openaiApiKey, previewUrl, terminalFontSize, sidebarCollapsed, terminalWebglEnabled, theme, tabOrder } = request.body || {};

    if (groqApiKey !== undefined && groqApiKey !== null && typeof groqApiKey !== 'string') {
      reply.code(400).send({ error: 'Invalid Groq API key format' });
      return;
    }

    // Validate API key format if provided (Groq keys start with gsk_)
    if (groqApiKey !== undefined && groqApiKey !== null && groqApiKey !== '') {
      if (!groqApiKey.startsWith('gsk_')) {
        reply.code(400).send({ error: 'Invalid Groq API key format (should start with gsk_)' });
        return;
      }
      if (groqApiKey.length < 20) {
        reply.code(400).send({ error: 'Groq API key is too short' });
        return;
      }
    }

    if (openaiApiKey !== undefined && openaiApiKey !== null && typeof openaiApiKey !== 'string') {
      reply.code(400).send({ error: 'Invalid OpenAI API key format' });
      return;
    }

    // Validate API key format if provided (OpenAI keys usually start with sk-)
    if (openaiApiKey !== undefined && openaiApiKey !== null && openaiApiKey !== '') {
      if (!openaiApiKey.startsWith('sk-')) {
        reply.code(400).send({ error: 'Invalid OpenAI API key format (should start with sk-)' });
        return;
      }
      if (openaiApiKey.length < 20) {
        reply.code(400).send({ error: 'OpenAI API key is too short' });
        return;
      }
    }

    // Validate terminal font size
    if (terminalFontSize !== undefined && terminalFontSize !== null) {
      if (typeof terminalFontSize !== 'number' || terminalFontSize < 8 || terminalFontSize > 32) {
        reply.code(400).send({ error: 'Terminal font size must be between 8 and 32' });
        return;
      }
    }

    if (terminalWebglEnabled !== undefined && terminalWebglEnabled !== null && typeof terminalWebglEnabled !== 'boolean') {
      reply.code(400).send({ error: 'Terminal WebGL setting must be a boolean' });
      return;
    }

    if (theme !== undefined && theme !== null && theme !== 'dark' && theme !== 'light') {
      reply.code(400).send({ error: 'Theme must be "dark" or "light"' });
      return;
    }

    if (tabOrder !== undefined && tabOrder !== null && !Array.isArray(tabOrder)) {
      reply.code(400).send({ error: 'Tab order must be an array of session IDs' });
      return;
    }

    const db = getDatabase();
    const now = new Date().toISOString();

    // Upsert the settings
    const existing = db.prepare('SELECT user_id FROM user_settings WHERE user_id = ?').get(userId);

    if (existing) {
      // Build dynamic update
      const updates: string[] = ['updated_at = ?'];
      const values: (string | number | null)[] = [now];

      if (groqApiKey !== undefined) {
        updates.push('groq_api_key = ?');
        values.push(groqApiKey === '' ? null : groqApiKey);
      }
      if (openaiApiKey !== undefined) {
        updates.push('openai_api_key = ?');
        values.push(openaiApiKey === '' ? null : openaiApiKey);
      }
      if (previewUrl !== undefined) {
        updates.push('preview_url = ?');
        values.push(previewUrl === '' ? null : previewUrl);
      }
      if (terminalFontSize !== undefined) {
        updates.push('terminal_font_size = ?');
        values.push(terminalFontSize);
      }
      if (sidebarCollapsed !== undefined) {
        updates.push('sidebar_collapsed = ?');
        values.push(sidebarCollapsed ? 1 : 0);
      }
      if (terminalWebglEnabled !== undefined) {
        updates.push('terminal_webgl_enabled = ?');
        values.push(terminalWebglEnabled ? 1 : 0);
      }
      if (theme !== undefined) {
        updates.push('theme = ?');
        values.push(theme);
      }
      if (tabOrder !== undefined) {
        updates.push('tab_order = ?');
        values.push(tabOrder ? JSON.stringify(tabOrder) : null);
      }

      values.push(userId);
      db.prepare(`UPDATE user_settings SET ${updates.join(', ')} WHERE user_id = ?`).run(...values);
    } else {
      db.prepare('INSERT INTO user_settings (user_id, groq_api_key, openai_api_key, preview_url, terminal_font_size, sidebar_collapsed, terminal_webgl_enabled, theme, tab_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        userId,
        groqApiKey || null,
        openaiApiKey || null,
        previewUrl || null,
        terminalFontSize ?? null,
        sidebarCollapsed ? 1 : 0,
        terminalWebglEnabled === undefined ? null : terminalWebglEnabled ? 1 : 0,
        theme || 'dark',
        tabOrder ? JSON.stringify(tabOrder) : null,
        now
      );
    }

    return { success: true };
  });
}

// Helper function to get user's Groq API key (for use in transcribe route)
export function getUserGroqApiKey(userId: string): string | null {
  const db = getDatabase();
  const row = db.prepare('SELECT groq_api_key FROM user_settings WHERE user_id = ?').get(userId) as { groq_api_key: string | null } | undefined;
  return row?.groq_api_key || null;
}

export function getUserOpenAIApiKey(userId: string): string | null {
  const db = getDatabase();
  const row = db.prepare('SELECT openai_api_key FROM user_settings WHERE user_id = ?').get(userId) as { openai_api_key: string | null } | undefined;
  return row?.openai_api_key || null;
}
