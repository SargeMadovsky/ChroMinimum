"""Summarize a completed isolated CEF smoke run; times are diagnostic, not benchmarks."""
import argparse
import json
from pathlib import Path


def summarize(run):
    report = json.loads((run / 'result.json').read_text(encoding='utf-8'))
    log = json.loads((run / 'netlog.json').read_text(encoding='utf-8'))
    names = {value: key for key, value in log['constants']['logEventTypes'].items()}
    events = log['events']
    request = next(e for e in events if names[e['type']] == 'URL_REQUEST_START_JOB'
                   and e.get('params', {}).get('url') == report['url'])
    origin = int(request['time'])
    request_id = request['source']['id']
    milestones = {}
    starts, cookie_loads = {}, []
    for event in events:
        name = names[event['type']]
        if event['source']['id'] == request_id and name in {
                'NETWORK_DELEGATE_BEFORE_START_TRANSACTION', 'HTTP_TRANSACTION_SEND_REQUEST',
                'HTTP_TRANSACTION_READ_HEADERS', 'CANCELLED'}:
            milestones.setdefault(f'{name}:{event["phase"]}', int(event['time']) - origin)
        if name == 'COOKIE_PERSISTENT_STORE_LOAD':
            source = event['source']['id']
            if event['phase'] == 1:
                starts[source] = int(event['time'])
            elif event['phase'] == 2 and source in starts:
                cookie_loads.append(int(event['time']) - starts.pop(source))
    summary = dict(passed=report['passed'], first_get_seconds=next(
        (r['received_seconds'] for r in report['requests'] if 'received_seconds' in r), None),
        connections=report.get('connections', []), request_milestones_ms=milestones,
        completed_cookie_loads_ms=cookie_loads, incomplete_cookie_loads=len(starts))
    trace_file = run / 'startup-trace.json'
    if trace_file.exists():
        trace = json.loads(trace_file.read_text(encoding='utf-8'))['traceEvents']
        complete = [e for e in trace if e.get('ph') == 'X']
        summary['sandbox_access_tasks_ms'] = [round(e['dur'] / 1000, 3) for e in complete
            if e.get('name') == 'ThreadPool_RunTask'
            and e.get('args', {}).get('src_func') == 'GrantSandboxAccessOnThreadPool']
        summary['cookie_database_init_ms'] = [round(e['dur'] / 1000, 3) for e in complete
            if e.get('name') == 'SQLitePersistentCookieStoreBackendBase::InitializeDatabase']
        summary['longest_blocking_calls'] = [dict(ms=round(e['dur'] / 1000, 3), args=e.get('args', {}))
            for e in sorted((e for e in complete if e.get('name') == 'ScopedBlockingCall'),
                            key=lambda e: e.get('dur', 0), reverse=True)[:10]]
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    text = json.dumps(summarize(args.run), ensure_ascii=False, indent=2)
    if args.output:
        with args.output.open('x', encoding='utf-8') as output:
            output.write(text + '\n')
    print(text)


if __name__ == '__main__':
    main()
