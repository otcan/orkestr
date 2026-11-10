"""Verify synthetic Rust bridge output; no subprocess, database or live I/O."""
from conversation_export import collect_pages
from snapshot import Invalid, fields, need


def verify_bridge(report):
    fields(report, ('format_version', 'expected', 'pages', 'refused_partial_pages',
                    'refusal_observed'))
    need(type(report['format_version']) is int and report['format_version'] == 1,
         'bridge_version')
    need(report['refusal_observed'] is True, 'bridge_refusal_not_observed')
    expected, _ = collect_pages([report['expected']])
    collected, digest = collect_pages(report['pages'])
    need(collected == expected, 'bridge_cut_mismatch')
    partial = report['refused_partial_pages']
    need(isinstance(partial, list) and len(partial) > 0, 'bridge_missing_partial')
    try:
        collect_pages(partial)
    except Invalid as error:
        # Only explicit incompleteness proves this was a valid prefix.
        need(str(error) == 'export_incomplete', 'bridge_invalid_partial')
    else:
        need(False, 'bridge_refusal_accepted_as_complete')
    return {'format_version': 1, 'status': 'pass', 'snapshot_digest': digest,
            'partial_discarded': True}
