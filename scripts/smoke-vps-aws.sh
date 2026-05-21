#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Run Orkestr's installer smoke test on a brand-new disposable AWS EC2 VPS.

The script creates a fresh Ubuntu 24.04 instance, restricts SSH to this
machine's public IP, runs scripts/bootstrap-vps.sh on the instance, runs
`npm run smoke` inside /opt/orkestr/app, and deletes the AWS resources.

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
  --keep                   Keep the EC2 instance, key pair, and security group after the run.
  --keep-on-failure        Keep AWS resources only when the smoke fails.
  --help                   Show this help.

Environment:
  ORKESTR_VPS_SMOKE_INSTANCE_TYPE
  ORKESTR_VPS_SMOKE_ROOT_GB
  ORKESTR_VPS_SMOKE_BOOTSTRAP_URL
  ORKESTR_VPS_SMOKE_SSH_CIDR
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
  ' || true
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

  log "Smoke test passed on fresh VPS: $instance_id"
}

main "$@"
