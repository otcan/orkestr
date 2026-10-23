import {Controller, Get, Query, Req} from '@nestjs/common';
import {isAdminPrincipal} from '../../../../../packages/core/src/policy.js';
import {requestPrincipal} from '../../../../../packages/core/src/principal.js';
import {discoverRemoteMessageWatches, importRemoteMessageChanges, importRemoteMessageThread} from '../../../../../packages/connectors/src/whatsapp-remote-changes.js';
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
        (query.signalOnly !== undefined && query.signalOnly !== '1') ||
        Object.keys(query).some(key => !['backend', 'cursor', 'signalOnly'].includes(key))) throw httpError('invalid_change_query', 400);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.res?.once('close', cancel);
    try {
      return await importRemoteMessageChanges({backendId: query.backend, cursor: String(query.cursor || ''), signal: controller.signal, signalOnly: query.signalOnly === '1'});
    } catch (error: any) {
      throw httpError(error.message || 'remote_change_import_failed', error.statusCode || 502);
    } finally { request.res?.off('close', cancel); }
  }
  @Get('sync')
  async sync(@Req() request: any, @Query() query: Record<string, unknown>) {
    if (!isAdminPrincipal(requestPrincipal(request))) throw httpError('admin_required', 403);
    if (typeof query.backend !== 'string' || typeof query.thread !== 'string' || query.thread.length > 256 ||
        Object.keys(query).some(key => !['backend', 'thread'].includes(key))) throw httpError('invalid_change_query', 400);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.res?.once('close', cancel);
    try {
      return await importRemoteMessageThread({backendId: query.backend, threadId: query.thread, signal: controller.signal});
    } catch (error: any) {
      throw httpError(error.message || 'remote_change_import_failed', error.statusCode || 502);
    } finally { request.res?.off('close', cancel); }
  }
}
