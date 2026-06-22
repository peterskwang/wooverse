#!/usr/bin/env python3
import argparse
import base64
import binascii
import json
import os
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional


def run_aliyun(args: List[str]) -> Dict[str, Any]:
    proc = subprocess.run(
        ["aliyun", *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if proc.returncode != 0:
        err = proc.stderr.strip() or proc.stdout.strip()
        raise RuntimeError(f"aliyun {' '.join(args)} failed: {err}")

    output = proc.stdout.strip()
    if not output:
        return {}

    try:
        return json.loads(output)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Failed to parse aliyun output as JSON: {output}") from exc


def maybe_decode_base64(text_value: str) -> str:
    if not text_value:
        return ""
    try:
        decoded = base64.b64decode(text_value, validate=True)
        return decoded.decode("utf-8", errors="replace")
    except (ValueError, binascii.Error):
        return text_value


def poll_invocation(
    region: str, instance_id: str, command_id: Optional[str], invoke_id: Optional[str]
) -> Dict[str, Any]:
    for _ in range(60):
        query = [
            "ecs",
            "DescribeInvocations",
            "--RegionId",
            region,
            "--InstanceId",
            instance_id,
            "--IncludeOutput",
            "true",
        ]
        if command_id:
            query.extend(["--CommandId", command_id])
        if invoke_id:
            query.extend(["--InvokeId", invoke_id])

        data = run_aliyun(
            query
        )

        invocations = data.get("Invocations", {}).get("Invocation", [])
        if not invocations:
            time.sleep(5)
            continue

        invocation = invocations[0]
        status = invocation.get("InvocationStatus") or invocation.get("InvokeStatus")
        if status in {"Running", "Pending", "Scheduled"}:
            time.sleep(5)
            continue

        return invocation

    raise TimeoutError("Timed out waiting for ECS invocation result")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Aliyun ECS RunCommand with Base64 content")
    parser.add_argument("--instance-id", required=True, help="ECS instance ID")
    parser.add_argument("--region", required=True, help="Aliyun region, e.g. cn-shanghai")
    parser.add_argument("--command", required=True, help="Base64-encoded shell command content")
    parser.add_argument(
        "--workdir",
        default="",
        help="RunCommand working directory; defaults to ALIYUN_RUNCOMMAND_WORKDIR or /opt/wooverse",
    )
    args = parser.parse_args()

    workdir = args.workdir or os.getenv("ALIYUN_RUNCOMMAND_WORKDIR", "/opt/wooverse")

    run_payload = [
        "ecs",
        "RunCommand",
        "--RegionId",
        args.region,
        "--InstanceId.1",
        args.instance_id,
        "--Type",
        "RunShellScript",
        "--ContentEncoding",
        "Base64",
        "--CommandContent",
        args.command,
        "--WorkingDir",
        workdir,
        "--Timeout",
        "1800",
        "--Name",
        "wooverse-github-actions-deploy",
    ]

    run_result = run_aliyun(run_payload)
    command_id = run_result.get("CommandId")
    invoke_id = run_result.get("InvokeId")
    if not command_id and not invoke_id:
        raise RuntimeError(f"RunCommand did not return CommandId/InvokeId: {run_result}")

    invocation = poll_invocation(args.region, args.instance_id, command_id, invoke_id)
    status = invocation.get("InvocationStatus") or invocation.get("InvokeStatus") or "Unknown"
    output = maybe_decode_base64(invocation.get("Output", ""))

    print(f"RunCommand status: {status}")
    if output:
        print("--- command output ---")
        print(output)

    if status not in {"Finished", "Success"}:
        error_info = invocation.get("ErrorInfo") or invocation.get("ErrorCode") or "Unknown error"
        print(f"RunCommand failed: {error_info}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
