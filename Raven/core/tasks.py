"""
Core Tasks Module

Task queue and orchestration with unlimited concurrent tasks.
Uses a queue-based system instead of thread pool to handle unlimited tasks.
"""

import queue
import threading
import time
from typing import Dict, Optional, Callable, Any, List
from datetime import datetime
from dataclasses import dataclass
from enum import Enum


class TaskStatus(Enum):
    """Task status"""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class Task:
    """Represents a task"""
    id: str
    name: str
    fn: Callable
    args: tuple
    kwargs: dict
    status: TaskStatus = TaskStatus.PENDING
    result: Any = None
    error: Optional[str] = None
    created_at: str = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    dependencies: list = None
    
    def __post_init__(self):
        if self.created_at is None:
            self.created_at = datetime.now().isoformat()
        if self.dependencies is None:
            self.dependencies = []


class TaskQueue:
    """Task queue with unlimited concurrent execution"""
    
    def __init__(self, max_workers: int = 10, queue_size: int = 100):
        self.queue = queue.Queue(maxsize=queue_size)
        self.tasks: Dict[str, Task] = {}
        self.max_workers = max_workers
        self.workers: list = []
        self.running = False
        self.task_counter = 0
        self._lock = threading.Lock()
    
    def start(self):
        """Start the task queue workers"""
        if self.running:
            return
        
        self.running = True
        for i in range(self.max_workers):
            worker = threading.Thread(target=self._worker, daemon=True)
            worker.start()
            self.workers.append(worker)
    
    def stop(self):
        """Stop the task queue workers"""
        self.running = False
        # Wake up all workers
        for _ in range(self.max_workers):
            self.queue.put(None)
        
        for worker in self.workers:
            worker.join(timeout=1)
        
        self.workers.clear()
    
    def _worker(self):
        """Worker thread that processes tasks from queue"""
        while self.running:
            try:
                task_id = self.queue.get(timeout=1)
                if task_id is None:
                    continue
                
                task = self.tasks.get(task_id)
                if not task:
                    continue
                
                # Check dependencies
                dependencies_met = True
                for dep_id in task.dependencies:
                    dep_task = self.tasks.get(dep_id)
                    if not dep_task or dep_task.status != TaskStatus.COMPLETED:
                        dependencies_met = False
                        break
                
                if not dependencies_met:
                    # Re-queue task
                    self.queue.put(task_id)
                    time.sleep(0.1)
                    continue
                
                # Execute task
                self._execute_task(task)
                
            except queue.Empty:
                continue
            except Exception as e:
                print(f"Worker error: {e}")
    
    def _execute_task(self, task: Task):
        """Execute a single task"""
        with self._lock:
            task.status = TaskStatus.RUNNING
            task.started_at = datetime.now().isoformat()
        
        try:
            result = task.fn(*task.args, **task.kwargs)
            with self._lock:
                task.result = result
                task.status = TaskStatus.COMPLETED
                task.completed_at = datetime.now().isoformat()
        except Exception as e:
            with self._lock:
                task.error = str(e)
                task.status = TaskStatus.FAILED
                task.completed_at = datetime.now().isoformat()
    
    def submit(self, name: str, fn: Callable, args: tuple = (), kwargs: dict = None, dependencies: list = None) -> str:
        """Submit a task to the queue"""
        if kwargs is None:
            kwargs = {}
        if dependencies is None:
            dependencies = []
        
        with self._lock:
            self.task_counter += 1
            task_id = f"task_{self.task_counter:04d}"
        
        task = Task(
            id=task_id,
            name=name,
            fn=fn,
            args=args,
            kwargs=kwargs,
            dependencies=dependencies
        )
        
        with self._lock:
            self.tasks[task_id] = task
        
        self.queue.put(task_id)
        
        if not self.running:
            self.start()
        
        return task_id
    
    def get_status(self, task_id: str) -> Optional[Dict]:
        """Get task status"""
        task = self.tasks.get(task_id)
        if not task:
            return None
        
        return {
            "id": task.id,
            "name": task.name,
            "status": task.status.value,
            "result": task.result,
            "error": task.error,
            "created_at": task.created_at,
            "started_at": task.started_at,
            "completed_at": task.completed_at,
            "dependencies": task.dependencies
        }
    
    def list(self) -> List[Dict]:
        """List all tasks"""
        with self._lock:
            return [self.get_status(task_id) for task_id in self.tasks.keys()]
    
    def cancel(self, task_id: str) -> bool:
        """Cancel a task"""
        task = self.tasks.get(task_id)
        if not task:
            return False
        
        if task.status in [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED]:
            return False
        
        with self._lock:
            task.status = TaskStatus.CANCELLED
            task.completed_at = datetime.now().isoformat()
        
        return True
    
    def clear_completed(self) -> int:
        """Clear completed tasks"""
        to_remove = []
        with self._lock:
            for task_id, task in self.tasks.items():
                if task.status in [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED]:
                    to_remove.append(task_id)
            
            for task_id in to_remove:
                del self.tasks[task_id]
        
        return len(to_remove)
    
    def get_stats(self) -> Dict:
        """Get queue statistics"""
        with self._lock:
            status_counts = {}
            for task in self.tasks.values():
                status = task.status.value
                status_counts[status] = status_counts.get(status, 0) + 1
            
            return {
                "total_tasks": len(self.tasks),
                "pending_tasks": status_counts.get("pending", 0),
                "running_tasks": status_counts.get("running", 0),
                "completed_tasks": status_counts.get("completed", 0),
                "failed_tasks": status_counts.get("failed", 0),
                "cancelled_tasks": status_counts.get("cancelled", 0),
                "queue_size": self.queue.qsize(),
                "max_workers": self.max_workers,
                "active_workers": len(self.workers)
            }
