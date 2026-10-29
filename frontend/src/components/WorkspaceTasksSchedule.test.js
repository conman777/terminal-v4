import { describe, expect, it } from 'vitest';
import { calendarTime, describeSchedule } from './WorkspaceTasksPanel';

describe('calendar schedules', () => {
  it('turns a time and days into the server format and describes it back', () => {
    const at = calendarTime('09:30', [5, 1, 2, 3, 4], 600);
    expect([at, describeSchedule({ at }), describeSchedule({ at: { ...at, weekdays: [0, 6] } }), describeSchedule({ intervalSeconds: 3600 })]).toEqual([
      { hour: 9, minute: 30, weekdays: [1, 2, 3, 4, 5], utcOffsetMinutes: 600 }, 'Weekdays at 09:30', 'Sun, Sat at 09:30', 'Every 60 minutes',
    ]);
  });
});
