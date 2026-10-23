import {Controller, Get, Query, Req} from '@nestjs/common';
import {isAdminPrincipal} from '../../../../../packages/core/src/policy.js';
import {requestPrincipal} from '../../../../../packages/core/src/principal.js';
import {discoverRemoteMessageWatches, importRemoteMessageChanges} from '../../../../../packages/connectors/src/whatsapp-remote-changes.js';
import {httpError} from '../../common/http.js';

@Controller('api/connectors/whatsapp/remote-runtime')
export class WhatsAppRemoteChangesController {
  @Get('watches')
  async watches(@Req() request: any) {
    if (!isAdminPrincipal(requestPrincipal(request))) throw httpError('admin_required', 403);
    return discoverRemoteMessageWatches();
  }

  @Get('changes')
  async changes(@Req() request: any, @Query() query: Record<string, unknown>) {
    if (!isAdminPrincipal(requestPrincipal(request))) throw httpError('admin_required', 403);
    if (typeof query.backend !== 'string' || (query.cursor !== undefined && typeof query.cursor !== 'string') ||
        Object.keys(query).some(key => !['backend', 'cursor'].includes(key))) throw httpError('invalid_change_query', 400);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.res?.once('close', cancel);
    try {
      return await importRemoteMessageChanges({backendId: query.backend, cursor: String(query.cursor || ''), signal: controller.signal});
    } catch (error: any) {
      throw httpError(error.message || 'remote_change_import_failed', error.statusCode || 502);
    } finally { request.res?.off('close', cancel); }
  }
}
