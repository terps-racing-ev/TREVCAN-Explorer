#!/usr/bin/env python3

import argparse
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional


CAN_NET_TYPE = "280"
RESERVED_NAMES = {"can0", "can1"}
MODULES = ("peak_usb", "gs_usb", "slcan")
ADAPTER_PRIORITY = {
    "pcan": 0,
    "canable": 1,
    "usb": 2,
}


@dataclass
class CanInterface:
    name: str
    driver: Optional[str]
    sysfs_path: Path
    is_usb: bool
    adapter_type: str


def run_command(command: List[str], dry_run: bool = False, check: bool = True) -> subprocess.CompletedProcess:
    if dry_run:
        print("[dry-run]", " ".join(command))
        return subprocess.CompletedProcess(command, 0, "", "")

    return subprocess.run(command, check=check, capture_output=True, text=True)


def load_kernel_modules(dry_run: bool = False) -> None:
    for module in MODULES:
        try:
            run_command(["modprobe", module], dry_run=dry_run, check=False)
        except FileNotFoundError:
            return


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def classify_adapter(driver: Optional[str], is_usb: bool) -> str:
    if driver in {"peak_usb", "pcan_usb_fd"}:
        return "pcan"
    if driver in {"gs_usb", "slcan"}:
        return "canable"
    if is_usb:
        return "usb"
    return "reserved"


def list_can_interfaces() -> List[CanInterface]:
    interfaces: List[CanInterface] = []
    net_dir = Path("/sys/class/net")

    if not net_dir.exists():
        return interfaces

    for iface_path in sorted(net_dir.iterdir()):
        type_path = iface_path / "type"
        if read_text(type_path) != CAN_NET_TYPE:
            continue

        device_path = iface_path / "device"
        resolved_device = device_path.resolve() if device_path.exists() else iface_path.resolve()
        driver_link = device_path / "driver"
        driver_name = driver_link.resolve().name if driver_link.exists() else None
        resolved_str = str(resolved_device)
        is_usb = "/usb" in resolved_str or driver_name in {"peak_usb", "pcan_usb_fd", "gs_usb", "slcan"}
        interfaces.append(
            CanInterface(
                name=iface_path.name,
                driver=driver_name,
                sysfs_path=resolved_device,
                is_usb=is_usb,
                adapter_type=classify_adapter(driver_name, is_usb),
            )
        )

    return interfaces


def build_plan(interfaces: List[CanInterface]) -> Dict[str, str]:
    plan: Dict[str, str] = {}

    onboard = [iface for iface in interfaces if not iface.is_usb]
    onboard.sort(key=lambda iface: iface.name)
    for index, iface in enumerate(onboard[:2]):
        plan[iface.name] = f"can{index}"

    managed_usb = [iface for iface in interfaces if iface.is_usb]
    managed_usb.sort(key=lambda iface: (ADAPTER_PRIORITY.get(iface.adapter_type, 99), iface.name))
    for index, iface in enumerate(managed_usb, start=2):
        plan[iface.name] = f"can{index}"

    return plan


def rename_interfaces(plan: Dict[str, str], dry_run: bool = False) -> Dict[str, str]:
    temporary_names: Dict[str, str] = {}
    occupied_names = set(plan.keys()) | set(plan.values())

    for step, current_name in enumerate(plan):
        target_name = plan[current_name]
        if current_name == target_name:
            continue

        temp_name = f"trevcan{step}"
        while temp_name in occupied_names or Path(f"/sys/class/net/{temp_name}").exists():
            step += 1
            temp_name = f"trevcan{step}"

        run_command(["ip", "link", "set", "dev", current_name, "down"], dry_run=dry_run, check=False)
        run_command(["ip", "link", "set", current_name, "name", temp_name], dry_run=dry_run)
        temporary_names[temp_name] = target_name
        occupied_names.add(temp_name)

    final_names: Dict[str, str] = {}

    for current_name, target_name in plan.items():
        if current_name == target_name:
            final_names[current_name] = target_name

    for temp_name, target_name in temporary_names.items():
        run_command(["ip", "link", "set", temp_name, "name", target_name], dry_run=dry_run)
        final_names[target_name] = target_name

    return final_names


def bring_up_interfaces(interface_names: List[str], bitrate: int, dry_run: bool = False) -> None:
    for name in interface_names:
        run_command(["ip", "link", "set", "dev", name, "down"], dry_run=dry_run, check=False)
        run_command(
            [
                "ip",
                "link",
                "set",
                "dev",
                name,
                "up",
                "type",
                "can",
                "bitrate",
                str(bitrate),
                "restart-ms",
                "100",
            ],
            dry_run=dry_run,
        )


def print_summary(interfaces: List[CanInterface], plan: Dict[str, str], bitrate: int) -> None:
    if not interfaces:
        print("No CAN interfaces detected.")
        return

    print("Detected CAN interfaces:")
    for iface in interfaces:
        role = "managed" if iface.name in plan else "unmanaged"
        target = plan.get(iface.name, iface.name)
        driver = iface.driver or "unknown"
        print(f"- {iface.name}: adapter={iface.adapter_type} driver={driver} role={role} target={target}")

    managed_usb = [iface for iface in interfaces if iface.is_usb]
    if managed_usb:
        print(f"Configured USB SocketCAN bitrate: {bitrate}")
    else:
        print("No USB CAN interfaces found to manage.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Normalize USB CAN adapters onto SocketCAN can2+ for TREVCAN Explorer."
    )
    parser.add_argument(
        "--bitrate",
        type=int,
        default=int(os.environ.get("TREVCAN_SOCKETCAN_BITRATE", "500000")),
        help="SocketCAN bitrate for managed USB adapters (default: %(default)s)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print planned changes without calling ip or modprobe",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if not args.dry_run and os.geteuid() != 0:
        print("socketcan_manager.py must run as root unless --dry-run is used.", file=sys.stderr)
        return 1

    load_kernel_modules(dry_run=args.dry_run)
    interfaces = list_can_interfaces()
    plan = build_plan(interfaces)
    usb_targets = [plan[iface.name] for iface in interfaces if iface.is_usb and iface.name in plan]
    print_summary(interfaces, plan, args.bitrate)

    if not plan:
        return 0

    rename_interfaces(plan, dry_run=args.dry_run)
    if usb_targets:
        bring_up_interfaces(sorted(usb_targets), bitrate=args.bitrate, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())