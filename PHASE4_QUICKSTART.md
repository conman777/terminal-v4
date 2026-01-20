# Phase 4 Integration - Quick Start Guide

## TL;DR

Phase 4 is 95% ready. Just need to copy-paste code from one file to another.

## What's Done

✓ All Phase 4 components exist and work
✓ Imports added to PreviewPanel.jsx
✓ Baseline storage directory created
✓ Complete integration code prepared
✓ Documentation written

## What's Needed

⏳ Copy-paste ~276 lines of code into PreviewPanel.jsx
⏳ Test the features

## How to Integrate (5 minutes)

### Step 1: Stop Dev Server
```bash
pkill -f "npm run dev"
```

### Step 2: Open Two Files Side-by-Side

**Left:** `/home/conor/terminal-v4/frontend/src/components/PreviewPanel.jsx`
**Right:** `/home/conor/terminal-v4/phase4-complete-integration.jsx`

### Step 3: Copy-Paste 4 Sections

Open the integration file and copy-paste each clearly-marked section:

1. **Section 1:** State variables (after line 115) - 6 lines
2. **Section 2:** Handlers (after line 797) - 165 lines
3. **Section 3:** Toolbar buttons (around line 1960) - 75 lines
4. **Section 4:** Modals (near the end) - 30 lines

Each section has clear `INSERT AFTER:` or `INSERT BEFORE:` comments.

### Step 4: Restart Dev Server
```bash
cd /home/conor/terminal-v4/frontend && npm run dev
```

### Step 5: Test

Open the browser and try:
- Click the phone icon (device presets)
- Click the eye icon (visual test)
- Click the grid icon (sessions)

## Files You Need

| File | Purpose |
|------|---------|
| `/home/conor/terminal-v4/phase4-complete-integration.jsx` | **Copy from here** |
| `/home/conor/terminal-v4/PHASE4_INTEGRATION_STATUS.md` | Detailed status |
| `/home/conor/terminal-v4/PHASE4_INTEGRATION_GUIDE.md` | Full guide |

## If Something Breaks

Check:
1. Did all 4 sections get copied?
2. Are imports at the top of the file?
3. Any syntax errors in the console?

## Expected Outcome

After integration, you'll have 5 new buttons in the PreviewPanel toolbar:

| Button | Icon | Feature |
|--------|------|---------|
| Device Presets | 📱 | Select mobile/tablet/desktop viewports |
| Reset Device | ↻ | Reset to normal viewport |
| Visual Test | 👁 | Run visual regression test |
| Set Baseline | 💾 | Save current screenshot as baseline |
| Sessions | ◻ | Manage isolated browser sessions |

## Need Help?

- **Can't find where to paste?** Each section in `phase4-complete-integration.jsx` has line number hints
- **Syntax errors?** Make sure you copied complete sections including opening/closing braces
- **Features don't work?** Check browser console for API errors

## Questions?

Read the full guide: `/home/conor/terminal-v4/PHASE4_INTEGRATION_GUIDE.md`

---

**Estimated Time:** 5-10 minutes for integration, 10-15 minutes for testing
