#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Run Orkestr's installer smoke test on a brand-new disposable AWS EC2 VPS.

The script creates a fresh Ubuntu 24.04 instance, restricts SSH to this
machine's public IP, runs scripts/bootstrap-vps.sh on the instance, runs
`npm run smoke` inside /opt/orkestr/app, optionally verifies WhatsApp QR
readiness, and deletes the AWS resources.

Requirements:
  aws, ssh, scp, curl, ssh-keygen
  AWS credentials with EC2 create/delete permissions

Usage:
  scripts/smoke-vps-aws.sh [options]

Options:
  --region REGION          AWS region. Defaults to AWS_REGION, AWS_DEFAULT_REGION, or us-east-2.
  --instance-type TYPE     EC2 type. Defaults to t3.medium.
  --disk-gb GB             Root disk size. Defaults to 60.
  --repo URL               Repo installed by bootstrap-vps.sh. Defaults to https://github.com/otcan/orkestr.git.
  --ref REF                Branch, tag, or commit installed by bootstrap-vps.sh. Defaults to main.
  --bootstrap-url URL      Remote bootstrap-vps.sh URL. Defaults to the otcan/orkestr raw URL for --ref.
  --local-bootstrap        Upload local scripts/bootstrap-vps.sh and scripts/install.sh instead of fetching bootstrap URL.
  --ssh-cidr CIDR          CIDR allowed to SSH. Defaults to this machine's public IP /32.
  --tailscale              Install Tailscale during bootstrap. Default is --no-tailscale.
  --tailscale-up           Run tailscale up during bootstrap. Requires TS_AUTHKEY for unattended runs.
  --auto-update            Install the on-box update timer. Default is --no-auto-update.
  --with-whatsapp          Start the built-in WhatsApp bridge and wait for QR readiness.
  --whatsapp-phone PHONE   Use WhatsApp phone-number pairing instead of QR. Digits may include +/spaces.
  --whatsapp-timeout SEC   Seconds to wait for WhatsApp QR readiness. Defaults to 240.
  --whatsapp-pair-timeout SEC
                            Seconds to wait for phone pairing approval. Defaults to --whatsapp-timeout.
  --create-whatsapp-thread NAME
                            After phone pairing succeeds, create a self-chat-backed test thread.
  --keep                   Keep the EC2 instance, key pair, and security group after the run.
  --keep-on-failure        Keep AWS resources only when the smoke fails.
  --help                   Show this help.

Environment:
  ORKESTR_VPS_SMOKE_INSTANCE_TYPE
  ORKESTR_VPS_SMOKE_ROOT_GB
  ORKESTR_VPS_SMOKE_BOOTSTRAP_URL
  ORKESTR_VPS_SMOKE_SSH_CIDR
  ORKESTR_VPS_SMOKE_WHATSAPP_TIMEOUT_SECONDS
USAGE
}

log() {
  printf '[orkestr-vps-smoke] %s\n' "$*"
}

die() {
  printf '[orkestr-vps-smoke] error: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

quote_args() {
  local arg
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
}

region="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}"
instance_type="${ORKESTR_VPS_SMOKE_INSTANCE_TYPE:-t3.medium}"
disk_gb="${ORKESTR_VPS_SMOKE_ROOT_GB:-60}"
repo_url="${ORKESTR_REPO_URL:-https://github.com/otcan/orkestr.git}"
git_ref="${ORKESTR_GIT_REF:-main}"
bootstrap_url="${ORKESTR_VPS_SMOKE_BOOTSTRAP_URL:-}"
ssh_cidr="${ORKESTR_VPS_SMOKE_SSH_CIDR:-}"
local_bootstrap=0
tailscale=0
tailscale_up=0
auto_update=0
with_whatsapp=0
whatsapp_timeout_seconds="${ORKESTR_VPS_SMOKE_WHATSAPP_TIMEOUT_SECONDS:-240}"
whatsapp_phone="${ORKESTR_VPS_SMOKE_WHATSAPP_PHONE:-}"
whatsapp_pair_timeout_seconds="${ORKESTR_VPS_SMOKE_WHATSAPP_PAIR_TIMEOUT_SECONDS:-}"
create_whatsapp_thread_name="${ORKESTR_VPS_SMOKE_WHATSAPP_THREAD_NAME:-}"
keep=0
keep_on_failure=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --region)
      region="${2:-}"
      shift 2
      ;;
    --instance-type)
      instance_type="${2:-}"
      shift 2
      ;;
    --disk-gb)
      disk_gb="${2:-}"
      shift 2
      ;;
    --repo)
      repo_url="${2:-}"
      shift 2
      ;;
    --ref)
      git_ref="${2:-}"
      shift 2
      ;;
    --bootstrap-url)
      bootstrap_url="${2:-}"
      shift 2
      ;;
    --local-bootstrap)
      local_bootstrap=1
      shift
      ;;
    --ssh-cidr)
      ssh_cidr="${2:-}"
      shift 2
      ;;
    --tailscale)
      tailscale=1
      shift
      ;;
    --no-tailscale)
      tailscale=0
      tailscale_up=0
      shift
      ;;
    --tailscale-up)
      tailscale=1
      tailscale_up=1
      shift
      ;;
    --auto-update)
      auto_update=1
      shift
      ;;
    --no-auto-update)
      auto_update=0
      shift
      ;;
    --with-whatsapp)
      with_whatsapp=1
      shift
      ;;
    --whatsapp-phone)
      with_whatsapp=1
      whatsapp_phone="${2:-}"
      shift 2
      ;;
    --whatsapp-timeout)
      whatsapp_timeout_seconds="${2:-}"
      shift 2
      ;;
    --whatsapp-pair-timeout)
      whatsapp_pair_timeout_seconds="${2:-}"
      shift 2
      ;;
    --create-whatsapp-thread)
      create_whatsapp_thread_name="${2:-}"
      shift 2
      ;;
    --keep)
      keep=1
      shift
      ;;
    --keep-on-failure)
      keep_on_failure=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[ -n "$region" ] || die "AWS region is required"
[ -n "$instance_type" ] || die "Instance type is required"
[ -n "$disk_gb" ] || die "Disk size is required"
[ -n "$repo_url" ] || die "Repo URL is required"
[ -n "$git_ref" ] || die "Git ref is required"
[ -n "$whatsapp_timeout_seconds" ] || die "WhatsApp readiness timeout is required"
if [ -z "$whatsapp_pair_timeout_seconds" ]; then
  whatsapp_pair_timeout_seconds="$whatsapp_timeout_seconds"
fi

if [ -z "$bootstrap_url" ]; then
  bootstrap_url="https://raw.githubusercontent.com/otcan/orkestr/${git_ref}/scripts/bootstrap-vps.sh"
fi

need aws
need curl
need scp
need ssh
need ssh-keygen

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
repo_root="$(cd "$script_dir/.." >/dev/null 2>&1 && pwd)"
work="$(mktemp -d /tmp/orkestr-vps-smoke.XXXXXX)"
key="$work/ssh_key"
known_hosts="$work/known_hosts"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
key_name="orkestr-smoke-$stamp"
sg_name="orkestr-smoke-$stamp"
instance_id=""
sg_id=""
public_ip=""

ssh_base_args=(
  -o StrictHostKeyChecking=accept-new
  -o UserKnownHostsFile="$known_hosts"
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=10
  -i "$key"
)

aws_ec2() {
  aws ec2 --region "$region" "$@"
}

ssh_run() {
  ssh "${ssh_base_args[@]}" "ubuntu@$public_ip" "$@"
}

collect_failure_logs() {
  [ -n "$public_ip" ] || return 0
  log "Collecting remote failure context"
  ssh_run 'set +e
    echo "== systemctl status orkestr =="
    systemctl status orkestr --no-pager --lines=80
    echo "== journalctl -u orkestr =="
    journalctl -u orkestr --no-pager -n 160
    echo "== bootstrap tail =="
    tail -n 160 /tmp/orkestr-bootstrap.log
    echo "== whatsapp readiness log =="
    tail -n 160 /tmp/orkestr-whatsapp-readiness.log
  ' || true
}

run_whatsapp_readiness_check() {
  log "Running WhatsApp readiness check"
  ssh_run "set -euo pipefail
    export WA_TIMEOUT_SECONDS=$(printf '%q' "$whatsapp_timeout_seconds")
    export WA_PAIR_TIMEOUT_SECONDS=$(printf '%q' "$whatsapp_pair_timeout_seconds")
    export WA_PHONE_NUMBER=$(printf '%q' "$whatsapp_phone")
    export WA_CREATE_THREAD_NAME=$(printf '%q' "$create_whatsapp_thread_name")
    node 2>&1 <<'NODE' | tee /tmp/orkestr-whatsapp-readiness.log
const { execFileSync } = require('node:child_process');

const baseUrl = 'http://127.0.0.1:19812';
const timeoutSeconds = Number(process.env.WA_TIMEOUT_SECONDS || 240);
const pairTimeoutSeconds = Number(process.env.WA_PAIR_TIMEOUT_SECONDS || timeoutSeconds);
const phoneNumber = String(process.env.WA_PHONE_NUMBER || '').replace(/\D+/g, '');
const createThreadName = String(process.env.WA_CREATE_THREAD_NAME || '').trim();
const deadline = Date.now() + timeoutSeconds * 1000;
const pairDeadline = Date.now() + pairTimeoutSeconds * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(path, options = {}) {
  const response = await fetch(baseUrl + path, options);
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(path + ' failed with HTTP ' + response.status + ': ' + JSON.stringify(payload).slice(0, 500));
  }
  return { response, payload };
}

async function postJson(path, body, headers = {}) {
  return readJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body || {}),
  });
}

function requireWhatsAppConnector(setup) {
  const whatsapp = setup.connectors?.find?.((connector) => connector.id === 'whatsapp');
  if (!whatsapp) throw new Error('setup status did not include the WhatsApp connector');
  if (!['not_connected', 'partial', 'connected'].includes(whatsapp.state)) {
    throw new Error('unexpected initial WhatsApp connector state: ' + whatsapp.state);
  }
  console.log('setup_whatsapp_state=' + whatsapp.state);
}

async function createSelfChatThread(headers) {
  if (!createThreadName) return;
  const createdChat = await postJson('/api/connectors/whatsapp/bridge/chats', {
    name: createThreadName,
    senderAccountId: 'account-1',
    responderAccountId: 'account-1',
  }, headers);
  const chat = createdChat.payload.chat || {};
  const chatId = String(chat.id || '').trim();
  if (!chatId) throw new Error('WhatsApp test chat creation did not return a chat id');
  const threadId = createThreadName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'whatsapp-phone-test';
  const thread = await postJson('/api/threads', {
    id: threadId,
    name: createThreadName,
    binding: {
      connector: 'whatsapp',
      chatId,
      displayName: createThreadName,
      enabled: true,
      mirrorToWhatsApp: true,
      senderAccountId: 'account-1',
      responderAccountId: 'account-1',
      outboundAccountId: 'account-1',
      senderContactId: createdChat.payload.senderContactId || '',
      responderContactId: createdChat.payload.responderContactId || '',
      generated: true,
    },
  }, headers);
  console.log('whatsapp_test_thread_id=' + (thread.payload.thread?.id || threadId));
  console.log('whatsapp_test_thread_name=' + createThreadName);
  console.log('whatsapp_test_chat_id=' + chatId);
  console.log('whatsapp_test_instruction=send a WhatsApp message to your own chat / Message yourself');
}

async function main() {
  const setup = await readJson('/api/setup/status');
  requireWhatsAppConnector(setup.payload);

  const challenge = await readJson('/api/setup/security/challenge', { method: 'POST' });
  const challengeId = String(challenge.payload.challengeId || '').trim();
  if (!challengeId) throw new Error('pairing challenge did not return challengeId');
  console.log('pairing_challenge=' + challengeId);
  execFileSync('sudo', ['orkestr', 'security', 'approve', challengeId], { stdio: 'inherit' });

  const pair = await readJson('/api/setup/security/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId }),
  });
  const setCookie = pair.response.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  if (!cookie) throw new Error('pairing did not return a session cookie');
  console.log('paired_session=' + (pair.payload.session?.id || 'ok'));

  const authHeaders = { cookie };
  const startPath = phoneNumber
    ? '/api/connectors/whatsapp/bridge/accounts/account-1/start-phone'
    : '/api/connectors/whatsapp/bridge/accounts/account-1/start';
  const start = await postJson(startPath, phoneNumber ? { phoneNumber } : {}, authHeaders);
  console.log('whatsapp_start_state=' + (start.payload.account?.state || 'unknown'));

  let lastState = '';
  let lastSummary = '';
  let lastPairingCode = '';
  while (Date.now() < (phoneNumber ? pairDeadline : deadline)) {
    const status = await readJson('/api/connectors/whatsapp/status', { headers: authHeaders });
    const state = String(status.payload.state || '');
    const summary = String(status.payload.summary || '');
    if (state !== lastState || summary !== lastSummary) {
      console.log('whatsapp_state=' + state + ' summary=' + summary);
      lastState = state;
      lastSummary = summary;
    }
    if (state === 'paired') {
      console.log('whatsapp_readiness=paired');
      await createSelfChatThread(authHeaders);
      process.exit(0);
    }
    if (phoneNumber && state === 'pairing_code') {
      const code = String(status.payload.pairingCode || '').trim();
      if (code && code !== lastPairingCode) {
        console.log('whatsapp_pairing_code=' + code);
        console.log('whatsapp_pairing_instruction=Open WhatsApp on your phone, go to Linked devices, choose Link with phone number, and enter this code.');
        lastPairingCode = code;
      }
      await sleep(3000);
      continue;
    }
    if (state === 'qr_needed') {
      if (phoneNumber) {
        throw new Error('WhatsApp fell back to QR mode before phone pairing code was generated');
      }
      const qr = await fetch(baseUrl + '/api/connectors/whatsapp/bridge/qr.svg?accountId=account-1', { headers: authHeaders });
      const svg = await qr.text();
      if (!qr.ok || !svg.includes('<svg')) {
        throw new Error('WhatsApp reported qr_needed but QR SVG was not available, HTTP ' + qr.status);
      }
      console.log('whatsapp_readiness=qr_needed qr_bytes=' + Buffer.byteLength(svg));
      process.exit(0);
    }
    if (['failed', 'unreachable'].includes(state)) {
      throw new Error('WhatsApp bridge failed before QR readiness: ' + (summary || state));
    }
    await sleep(3000);
  }

  if (phoneNumber) {
    throw new Error('WhatsApp phone pairing timed out after ' + pairTimeoutSeconds + 's; last state=' + (lastState || 'unknown') + ' summary=' + lastSummary);
  }
  throw new Error('WhatsApp QR readiness timed out after ' + timeoutSeconds + 's; last state=' + (lastState || 'unknown') + ' summary=' + lastSummary);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
NODE
    "
}

cleanup() {
  local status
  status="$?"
  trap - EXIT

  if [ "$status" -ne 0 ]; then
    collect_failure_logs
  fi

  if [ "$keep" -eq 1 ] || { [ "$status" -ne 0 ] && [ "$keep_on_failure" -eq 1 ]; }; then
    log "Keeping AWS resources for inspection"
    [ -n "$instance_id" ] && log "instance=$instance_id"
    [ -n "$public_ip" ] && log "public_ip=$public_ip"
    [ -n "$key" ] && log "ssh_key=$key"
    [ -n "$sg_id" ] && log "security_group=$sg_id"
    exit "$status"
  fi

  if [ -n "$instance_id" ]; then
    log "Terminating EC2 instance: $instance_id"
    aws_ec2 terminate-instances --instance-ids "$instance_id" >/dev/null 2>&1 || true
    aws_ec2 wait instance-terminated --instance-ids "$instance_id" >/dev/null 2>&1 || true
  fi
  if [ -n "$key_name" ]; then
    log "Deleting key pair: $key_name"
    aws_ec2 delete-key-pair --key-name "$key_name" >/dev/null 2>&1 || true
  fi
  if [ -n "$sg_id" ]; then
    log "Deleting security group: $sg_id"
    aws_ec2 delete-security-group --group-id "$sg_id" >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

main() {
  local my_ip vpc_id ami_id launch_name bootstrap_args remote_cmd

  if [ -z "$ssh_cidr" ]; then
    my_ip="$(curl -fsSL https://checkip.amazonaws.com | tr -d '[:space:]')"
    ssh_cidr="$my_ip/32"
  fi

  log "Creating disposable Ubuntu 24.04 VPS in $region"
  log "instance_type=$instance_type disk_gb=$disk_gb ssh_cidr=$ssh_cidr"

  ssh-keygen -q -t ed25519 -N '' -C "$key_name" -f "$key"

  vpc_id="$(aws_ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
  [ -n "$vpc_id" ] && [ "$vpc_id" != "None" ] || die "No default VPC found in $region"

  sg_id="$(aws_ec2 create-security-group \
    --group-name "$sg_name" \
    --description "Orkestr disposable installer smoke $stamp" \
    --vpc-id "$vpc_id" \
    --query GroupId \
    --output text)"
  aws_ec2 create-tags --resources "$sg_id" --tags \
    Key=Name,Value="$sg_name" \
    Key=Project,Value=orkestr \
    Key=Purpose,Value=installer-smoke \
    Key=Owner,Value=codex >/dev/null
  aws_ec2 authorize-security-group-ingress \
    --group-id "$sg_id" \
    --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$ssh_cidr,Description=controller-ssh}]" >/dev/null

  aws_ec2 import-key-pair --key-name "$key_name" --public-key-material "fileb://$key.pub" >/dev/null

  ami_id="$(aws ssm get-parameter \
    --region "$region" \
    --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
    --query Parameter.Value \
    --output text)"

  launch_name="orkestr-installer-smoke-$stamp"
  instance_id="$(aws_ec2 run-instances \
    --image-id "$ami_id" \
    --instance-type "$instance_type" \
    --key-name "$key_name" \
    --security-group-ids "$sg_id" \
    --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":${disk_gb},\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
    --tag-specifications \
      "ResourceType=instance,Tags=[{Key=Name,Value=$launch_name},{Key=Project,Value=orkestr},{Key=Purpose,Value=installer-smoke},{Key=Owner,Value=codex},{Key=DeleteAfter,Value=$stamp}]" \
      "ResourceType=volume,Tags=[{Key=Name,Value=$launch_name},{Key=Project,Value=orkestr},{Key=Purpose,Value=installer-smoke},{Key=Owner,Value=codex}]" \
    --query 'Instances[0].InstanceId' \
    --output text)"

  log "Waiting for EC2 status checks: $instance_id"
  aws_ec2 wait instance-running --instance-ids "$instance_id"
  aws_ec2 wait instance-status-ok --instance-ids "$instance_id"
  public_ip="$(aws_ec2 describe-instances \
    --instance-ids "$instance_id" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' \
    --output text)"
  log "public_ip=$public_ip"

  log "Waiting for SSH"
  for _ in $(seq 1 40); do
    if ssh "${ssh_base_args[@]}" -o ConnectTimeout=10 "ubuntu@$public_ip" true >/dev/null 2>&1; then
      break
    fi
    sleep 3
  done
  ssh_run 'set -e; . /etc/os-release; printf "os=%s %s\n" "$NAME" "$VERSION_ID"; printf "kernel=%s\n" "$(uname -r)"; printf "cpu=%s\n" "$(nproc)"; free -h | awk "/Mem:/ {print \"mem=\" \$2}"; df -h / | awk "NR==2 {print \"root_disk=\" \$2}"'

  bootstrap_args=(--repo "$repo_url" --ref "$git_ref")
  if [ "$tailscale" -eq 1 ]; then
    bootstrap_args+=(--tailscale)
  else
    bootstrap_args+=(--no-tailscale)
  fi
  if [ "$tailscale_up" -eq 1 ]; then
    bootstrap_args+=(--tailscale-up)
  fi
  if [ "$auto_update" -eq 1 ]; then
    bootstrap_args+=(--auto-update)
  else
    bootstrap_args+=(--no-auto-update)
  fi
  if [ "$with_whatsapp" -eq 1 ]; then
    bootstrap_args+=(--with-whatsapp)
  fi

  if [ "$local_bootstrap" -eq 1 ]; then
    log "Uploading local bootstrap/install scripts"
    ssh_run 'mkdir -p /tmp/orkestr-vps-smoke'
    scp "${ssh_base_args[@]}" \
      "$repo_root/scripts/bootstrap-vps.sh" \
      "$repo_root/scripts/install.sh" \
      "ubuntu@$public_ip:/tmp/orkestr-vps-smoke/" >/dev/null
    remote_cmd="set -euo pipefail; chmod +x /tmp/orkestr-vps-smoke/bootstrap-vps.sh /tmp/orkestr-vps-smoke/install.sh; sudo env DEBIAN_FRONTEND=noninteractive /tmp/orkestr-vps-smoke/bootstrap-vps.sh$(quote_args "${bootstrap_args[@]}") 2>&1 | tee /tmp/orkestr-bootstrap.log"
  else
    log "Fetching bootstrap script: $bootstrap_url"
    remote_cmd="set -euo pipefail; curl -fsSL $(printf '%q' "$bootstrap_url") -o /tmp/bootstrap-vps.sh; chmod +x /tmp/bootstrap-vps.sh; sudo env DEBIAN_FRONTEND=noninteractive /tmp/bootstrap-vps.sh$(quote_args "${bootstrap_args[@]}") 2>&1 | tee /tmp/orkestr-bootstrap.log"
  fi

  log "Running installer on fresh VPS"
  ssh_run "$remote_cmd"

  log "Running remote smoke test"
  ssh_run 'set -euo pipefail
    printf "service=%s\n" "$(systemctl is-active orkestr)"
    printf "version="
    curl -fsS http://127.0.0.1:19812/api/version
    printf "\n"
    cd /opt/orkestr/app
    npm run smoke
  '
  if [ "$with_whatsapp" -eq 1 ]; then
    run_whatsapp_readiness_check
  fi

  log "Smoke test passed on fresh VPS: $instance_id"
}

main "$@"
