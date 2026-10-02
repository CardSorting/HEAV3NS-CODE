"""Readable evidence, with original structured data available on demand."""
import json
from datetime import datetime


def observed(value):
    try:
        return datetime.fromtimestamp(value / 1000).astimezone().strftime('%x %X %Z')
    except (TypeError, ValueError, OverflowError, OSError):
        return 'Time unavailable'


def humanize(value):
    return str(value or 'Unknown').replace('_', ' ').replace('-', ' ').capitalize()


def render_evidence(method, result):
    if 'text' in result:
        return result['text']
    if method == 'history.read':
        run, insight = result.get('run', {}), result.get('insight', {})
        sections = [humanize(run.get('state')) + ' · ' + observed(run.get('createdAt'))]
        for key, title in [('outcome', 'Outcome'), ('nextStep', 'Next step'), ('checks', 'Project checks'), ('coverage', 'Recorded evidence')]:
            if insight.get(key):
                sections.append(title + '\n' + insight[key])
        integrity = result.get('storedEvidence', 'unavailable')
        sections.append('Saved content\n' + ('Checksum verified. This does not verify project files or passing tests.' if integrity == 'verified' else 'Integrity: ' + integrity))
        for key, title in [('text', 'Instruction'), ('response', 'Result'), ('error', 'Error'), ('checkpointError', 'Checkpoint detail')]:
            if run.get(key):
                sections.append(title + '\n' + str(run[key]))
        sections.extend(str(item) for item in insight.get('warnings', []))
        sections.append(result.get('outputMessage', 'No recorded output information.'))
        return '\n\n'.join(sections)
    if method == 'activity.list':
        activities = result.get('activities', [])
        sections = [f"Walkthrough · {len(activities)} retained of {result.get('activityCount', len(activities))} recorded activities"]
        for item in activities:
            sections.append(f"{humanize(item.get('status'))} · {item.get('message', 'Activity')}\n" + str(item.get('detail', '')))
            if item.get('preview', {}).get('text'):
                sections.append(item['preview']['text'] + ('\n[Preview limited]' if item['preview'].get('limited') else ''))
        return '\n\n'.join(sections)
    if method == 'context.inspect':
        return (f"Conversation context\nObserved {observed(result.get('observedAt'))}\n\n"
                f"Active messages: {result.get('activeMessages', 0)}\nRolling summaries: {result.get('rollingSummaries', 0)}\n"
                f"Saved memories: {result.get('savedMemories', 0)}\n\n"
                "This is retained context, not the complete provider request or a context quality score.")
    if method == 'state.inspect':
        sections = [result.get('summary', 'Saved state'), result.get('scope', ''), 'Next step\n' + result.get('nextAction', '')]
        for run in result.get('runs', []):
            sections.append(f"{humanize(run.get('state'))} · {run.get('title', 'Instruction')}\nIntegrity: {run.get('integrity', 'unknown')}\n" + '\n'.join(run.get('issues', [])))
        return '\n\n'.join(sections)
    if method == 'spider.check':
        sections = [result.get('summary', 'Code check'), result.get('scope', ''), result.get('nextAction', '')]
        for item in result.get('findings', []):
            sections.append(f"{humanize(item.get('severity'))} · {item.get('path', '')}:{item.get('line', 1)}\n{item.get('message', '')}\n{item.get('remediation', '')}")
        sections.extend(result.get('coverage', {}).get('limitations', []))
        return '\n\n'.join(sections)
    return json.dumps(result, indent=2, ensure_ascii=False)
