"""Copy into the disposable pinned Core export's tests/gateway; never a live runtime."""
import asyncio
import os
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer, make_mocked_request
from tests.gateway.test_api_chat_receipt_authority import _app, _answer, AUTH

@pytest.mark.asyncio
async def test_lpanel_real_http_recovery_chain(api, owner):
    calls = []
    _answer(api, owner, calls)
    app = _app(api)
    app.router.add_get('/api/sessions/{session_id}/messages', api._handle_session_messages)
    app.router.add_post('/v1/runs/{run_id}/resolve-unknown', api._handle_resolve_unknown_run)
    async def unknown(request):
        from gateway.session_api_turn import admit_api_turn
        from gateway.session_authority import initialize_session_authority
        from hermes_state_runtime import claim_session_input
        producer = make_mocked_request('POST', '/v1/chat/completions', headers={**AUTH, 'Idempotency-Key': '46b09436-de77-42c1-a711-1b923ca02843'})
        admit_api_turn(api, session_id='unknown-chain', request_id=api._chat_request_id(producer), run_owner_scope=api._run_idempotency_scope(producer), user_message='never replay', conversation_history=[])
        claim_session_input(owner.db, epoch=owner.runner.session_authority.epoch, session_id='unknown-chain')
        await initialize_session_authority(owner.runner, profile_id='default', instance_id='after-loss', db=owner.db)
        return web.json_response({'fixture': 'unknown'})
    app.router.add_post('/fixture/unknown', unknown)
    async with TestClient(TestServer(app)) as client:
        env = {**os.environ, 'T14_CORE_PORT': str(client.server.port)}
        process = await asyncio.create_subprocess_exec('node', '--experimental-strip-types', os.environ['T14_NODE_FIXTURE'], stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=env)
        stdout, _ = await asyncio.wait_for(process.communicate(), 45)
        assert process.returncode == 0, stdout.decode()
        print(stdout.decode())
    assert calls == ['once from LP']
