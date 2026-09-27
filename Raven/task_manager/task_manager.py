from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional, Callable, Any
from concurrent.futures import ThreadPoolExecutor, Future
from rich.console import Console
from rich.table import Table


class TaskStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class Task:
    task_id: str
    name: str
    description: str
    func: Callable
    args: tuple = field(default_factory=tuple)
    kwargs: dict = field(default_factory=dict)
    status: TaskStatus = TaskStatus.PENDING
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    result: Any = None
    error: Optional[str] = None
    dependencies: List[str] = field(default_factory=list)  # Task IDs this task depends on


class TaskManager:
    def __init__(self, max_workers: int = 4, console: Console = None):
        self.max_workers = max_workers
        self.console = console or Console()
        self.tasks: Dict[str, Task] = {}
        self.executor = ThreadPoolExecutor(max_workers=max_workers)
        self.futures: Dict[str, Future] = {}
        self._task_counter = 0
        self._lock = threading.Lock()

    def create_task(
        self,
        name: str,
        description: str,
        func: Callable,
        args: tuple = (),
        kwargs: dict = None,
        dependencies: List[str] = None
    ) -> str:
        """Create a new task and return its ID."""
        with self._lock:
            self._task_counter += 1
            task_id = f"task_{self._task_counter:04d}"
        
        task = Task(
            task_id=task_id,
            name=name,
            description=description,
            func=func,
            args=args,
            kwargs=kwargs or {},
            dependencies=dependencies or []
        )
        
        self.tasks[task_id] = task
        self.console.print(f"[green]done[/green] Task created: [cyan]{task_id}[/cyan] - {name}")
        return task_id

    def submit_task(self, task_id: str) -> bool:
        """Submit a task for execution."""
        if task_id not in self.tasks:
            self.console.print(f"[red]Task {task_id} not found[/red]")
            return False
        
        task = self.tasks[task_id]
        
        # Check dependencies
        for dep_id in task.dependencies:
            if dep_id not in self.tasks:
                self.console.print(f"[red]Dependency {dep_id} not found for task {task_id}[/red]")
                return False
            dep_task = self.tasks[dep_id]
            if dep_task.status != TaskStatus.COMPLETED:
                self.console.print(f"[yellow]Dependency {dep_id} not completed for task {task_id}[/yellow]")
                return False
        
        if task.status != TaskStatus.PENDING:
            self.console.print(f"[yellow]Task {task_id} is not in PENDING state[/yellow]")
            return False
        
        task.status = TaskStatus.RUNNING
        task.started_at = datetime.now().isoformat()
        
        def task_wrapper():
            try:
                result = task.func(*task.args, **task.kwargs)
                task.result = result
                task.status = TaskStatus.COMPLETED
                task.completed_at = datetime.now().isoformat()
                self.console.print(f"[green]+[/green] Task completed: [cyan]{task_id}[/cyan]")
                return result
            except Exception as e:
                task.error = str(e)
                task.status = TaskStatus.FAILED
                task.completed_at = datetime.now().isoformat()
                self.console.print(f"[red]X[/red] Task failed: [cyan]{task_id}[/cyan] - {e}")
                raise
        
        future = self.executor.submit(task_wrapper)
        self.futures[task_id] = future
        self.console.print(f"[blue]->[/blue] Task started: [cyan]{task_id}[/cyan]")
        return True

    def submit_batch(self, task_ids: List[str]) -> Dict[str, bool]:
        """Submit multiple tasks for execution."""
        results = {}
        for task_id in task_ids:
            results[task_id] = self.submit_task(task_id)
        return results

    def get_task(self, task_id: str) -> Optional[Task]:
        """Get a task by ID."""
        return self.tasks.get(task_id)

    def get_task_status(self, task_id: str) -> Optional[TaskStatus]:
        """Get the status of a task."""
        task = self.get_task(task_id)
        return task.status if task else None

    def cancel_task(self, task_id: str) -> bool:
        """Cancel a task."""
        if task_id not in self.tasks:
            return False
        
        task = self.tasks[task_id]
        
        if task_id in self.futures:
            future = self.futures[task_id]
            cancelled = future.cancel()
            if cancelled:
                task.status = TaskStatus.CANCELLED
                task.completed_at = datetime.now().isoformat()
                del self.futures[task_id]
                self.console.print(f"[yellow]⊘[/yellow] Task cancelled: [cyan]{task_id}[/cyan]")
                return True
        
        return False

    def wait_for_task(self, task_id: str, timeout: Optional[float] = None) -> Any:
        """Wait for a task to complete and return its result."""
        if task_id not in self.futures:
            task = self.get_task(task_id)
            if task and task.status == TaskStatus.COMPLETED:
                return task.result
            return None
        
        future = self.futures[task_id]
        try:
            result = future.result(timeout=timeout)
            return result
        except Exception as e:
            return None

    def wait_for_all(self, task_ids: List[str], timeout: Optional[float] = None) -> Dict[str, Any]:
        """Wait for multiple tasks to complete."""
        results = {}
        for task_id in task_ids:
            results[task_id] = self.wait_for_task(task_id, timeout)
        return results

    def list_tasks(self, status_filter: Optional[TaskStatus] = None) -> List[Task]:
        """List all tasks, optionally filtered by status."""
        tasks = list(self.tasks.values())
        if status_filter:
            tasks = [t for t in tasks if t.status == status_filter]
        return sorted(tasks, key=lambda t: t.created_at, reverse=True)

    def display_tasks(self, status_filter: Optional[TaskStatus] = None):
        """Display tasks in a table format."""
        tasks = self.list_tasks(status_filter)
        
        if not tasks:
            self.console.print("[yellow]No tasks found[/yellow]")
            return
        
        table = Table(title="Tasks")
        table.add_column("ID", style="cyan")
        table.add_column("Name", style="green")
        table.add_column("Status", style="yellow")
        table.add_column("Created", style="dim")
        table.add_column("Duration", style="dim")
        
        for task in tasks:
            # Calculate duration
            duration = "N/A"
            if task.started_at and task.completed_at:
                start = datetime.fromisoformat(task.started_at)
                end = datetime.fromisoformat(task.completed_at)
                duration = str(end - start).split('.')[0]  # Remove microseconds
            elif task.started_at:
                start = datetime.fromisoformat(task.started_at)
                duration = str(datetime.now() - start).split('.')[0]
            
            # Status color
            status_color = {
                TaskStatus.PENDING: "dim",
                TaskStatus.RUNNING: "blue",
                TaskStatus.COMPLETED: "green",
                TaskStatus.FAILED: "red",
                TaskStatus.CANCELLED: "yellow"
            }.get(task.status, "white")
            
            table.add_row(
                task.task_id,
                task.name[:20],  # Truncate long names
                f"[{status_color}]{task.status.value}[/{status_color}]",
                task.created_at[:19],
                duration
            )
        
        self.console.print(table)

    def clear_completed(self) -> int:
        """Clear completed tasks from memory."""
        completed_ids = [
            task_id for task_id, task in self.tasks.items()
            if task.status in [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED]
        ]
        
        for task_id in completed_ids:
            del self.tasks[task_id]
            if task_id in self.futures:
                del self.futures[task_id]
        
        self.console.print(f"[green]+[/green] Cleared {len(completed_ids)} completed tasks")
        return len(completed_ids)

    def get_statistics(self) -> Dict[str, int]:
        """Get task statistics."""
        stats = {
            "total": len(self.tasks),
            "pending": 0,
            "running": 0,
            "completed": 0,
            "failed": 0,
            "cancelled": 0
        }
        
        for task in self.tasks.values():
            stats[task.status.value] += 1
        
        return stats

    def shutdown(self):
        """Shutdown the task manager and wait for all tasks to complete."""
        self.console.print("[yellow]Shutting down task manager...[/yellow]")
        self.executor.shutdown(wait=True)
        self.console.print("[green]done[/green] Task manager shutdown complete")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.shutdown()
