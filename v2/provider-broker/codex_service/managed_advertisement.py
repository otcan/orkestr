"""Fixed provider-side MCP configuration from the original Root launch capsule."""
import json
import re
from .contract import require


def valid_url(value):
    match=re.fullmatch(r'http://127\.0\.0\.1:([1-9][0-9]{0,4})/mcp',value) if type(value) is str else None
    require(match and int(match.group(1))<65536,'managed_mcp_url')
    return value


def url(package):
    if not getattr(package,'runtime',{}).get('managed_operations'):return None
    from .identity import launch_context
    context=launch_context()
    require(package.identity_split and type(context) is dict,'managed_mcp_context')
    if context['role'] not in ('deep','claude') or context['setup']['role']!='deep':return None
    require(type(package.beta.get('managed_host')) is dict,'managed_mcp_host_required')
    return valid_url(context.get('managed_mcp_url'))


def codex_options(package):
    selected=url(package)
    if selected is None:return ()
    # Pin routing, requirement and timeout. Provider config layers can retain
    # extra headers; Root never treats a header or bearer as caller authority.
    value='{url='+json.dumps(selected)+',enabled=true,required=true,tool_timeout_sec=330}'
    return ('-c','mcp_servers.orkestr_managed='+value)


def claude_options(package):
    selected=url(package)
    if selected is None:return ()
    return ('--mcp-config',json.dumps({'mcpServers':{'orkestr_managed':{'type':'http','url':selected}}},separators=(',',':')))
