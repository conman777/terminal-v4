"""Native Hermes branch helper. Never edits the selected source conversation."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys


def native_path(value):
    resolved = str(Path(value).resolve(strict=True))
    if os.name == 'nt':
        if resolved.startswith('\\\\?\\UNC\\'):
            resolved = '\\\\' + resolved[8:]
        elif resolved.startswith('\\\\?\\'):
            resolved = resolved[4:]
    return Path(resolved)


def snapshot(db, session_id, workspace):
    from agent.context_compressor import user_originated_turn_view
    meta = db.get_session(session_id)
    if not meta or meta.get('source') != 'cli' or native_path(meta.get('cwd') or '') != workspace:
        raise ValueError('Conversation is outside this workspace')
    messages = db.get_messages_as_conversation(session_id, include_row_ids=True, repair_alternation=True)
    if len(messages) > 2000:
        raise ValueError('Conversation exceeds rewind history limit')
    encoded = json.dumps({'meta': meta, 'messages': messages}, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(encoded) > 8 * 1024 * 1024:
        raise ValueError('Conversation exceeds rewind byte limit')
    turns = []
    for message in messages:
        view = user_originated_turn_view(message)
        if view is not None:
            from agent.message_content import flatten_message_text
            turns.append({'id': str(message['_row_id']), 'prompt': flatten_message_text(view.get('content'))[:12000], 'ordinal': len(turns), 'supported': True, 'reason': None})
    return meta, messages, turns, hashlib.sha256(encoded).hexdigest()


def run(request):
    from hermes_state import SessionDB
    workspace = native_path(request['workspace'])
    database = native_path(request['database'])
    if database.stat().st_size > 256 * 1024 * 1024:
        raise ValueError('Native database exceeds rewind scan limit')
    operation = request['operation']
    db = SessionDB(database, read_only=operation == 'list')
    try:
        if operation == 'list':
            connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
            try:
                ids = connection.execute("SELECT id,cwd FROM sessions WHERE source='cli' AND cwd IS NOT NULL ORDER BY started_at DESC LIMIT 500").fetchall()
            finally:
                connection.close()
            result = []
            for session_id, cwd in ids:
                try:
                    if native_path(cwd) != workspace:
                        continue
                    meta, messages, turns, fingerprint = snapshot(db, session_id, workspace)
                    if turns:
                        result.append({'nativeSessionId': session_id, 'turns': turns, 'fingerprint': fingerprint, 'title': meta.get('title') or turns[0]['prompt'][:100]})
                    if len(result) >= 50:
                        break
                except (ValueError, KeyError, OSError):
                    continue
            return result
        if operation != 'fork':
            raise ValueError('Unknown native operation')
        source = request['sessionId']
        meta, messages, turns, fingerprint = snapshot(db, source, workspace)
        if fingerprint != request['fingerprint']:
            raise ValueError('Conversation changed; review a fresh rewind plan')
        target = next(turn for turn in turns if turn['id'] == request['targetTurnId'])
        from agent.context_compressor import history_before_user_originated_turn
        index = next(i for i, message in enumerate(messages) if str(message.get('_row_id')) == target['id'])
        prefix, _ = history_before_user_originated_turn(messages, index)
        from hermes_state_ids import new_session_id
        from agent.message_metadata import message_identity
        from agent.turn_context import extract_api_content_sidecar
        branch = new_session_id()
        config = dict(meta['model_config']) if isinstance(meta.get('model_config'), dict) else json.loads(meta.get('model_config') or '{}')
        config['_branched_from'] = source
        config.pop('_session_yolo', None)
        db.create_session(branch, source='cli', model=meta.get('model'), parent_session_id=source,
                          cwd=str(workspace), system_prompt=meta.get('system_prompt'), model_config=config)
        keys = ('content', 'tool_calls', 'tool_call_id', 'reasoning', 'reasoning_content', 'reasoning_details', 'codex_reasoning_items', 'codex_message_items', 'timestamp')
        try:
            rows = [{'role': message.get('role', 'user'), 'tool_name': message.get('tool_name') or message.get('name'),
                     'api_content': extract_api_content_sidecar(message), **{key: message.get(key) for key in keys},
                     **message_identity(message, with_tool_uids=True)} for message in prefix]
            db.append_messages_batch(branch, rows)
            db.set_session_title(branch, 'Terminal v4 rewind')
            if snapshot(db, source, workspace)[3] != fingerprint:
                raise ValueError('Source changed while forking')
        except BaseException:
            db.delete_session(branch, include_compression_chain=False)
            raise
        return {'sessionId': branch}
    finally:
        db.close()


if __name__ == '__main__':
    try:
        request = json.loads(sys.argv[1])
        print(json.dumps(run(request), ensure_ascii=False))
    except Exception:
        sys.stderr.write('Native Hermes rewind failed; no source conversation was changed')
        sys.exit(1)
