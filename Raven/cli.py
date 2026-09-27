"""
Raven CLI - Main Entry Point

Unified CLI using Raven Core with all features:
- Direct command: `raven` (no `raven chat` needed)
- Integrated configuration (no env vars needed)
- Skills management
- PATH system integration
- /restart command
- Unlimited task queue
"""

import sys
import os
import threading
import time
import subprocess
import click
from pathlib import Path
try:
    from prompt_toolkit import PromptSession
    from prompt_toolkit.completion import Completer, Completion, CompleteStyle
    from prompt_toolkit.styles import Style
    from prompt_toolkit.key_binding import KeyBindings
except ImportError:
    PromptSession = None
    class Completer:
        pass
    class Completion:
        def __init__(self, text, start_position=0, **kwargs):
            self.text = text
    CompleteStyle = None
    Style = None
    KeyBindings = None


class SlashCompleter(Completer):
    """Offer command completions only for input lines beginning with /."""

    def __init__(self, words):
        self.words = sorted(words, key=lambda item: item[0] if isinstance(item, tuple) else item)

    def get_completions(self, document, complete_event):
        text = document.text_before_cursor
        slash_index = text.rfind("/")
        if slash_index < 0:
            return
        prefix = text[slash_index:]
        for item in self.words:
            word, description = item if isinstance(item, tuple) else (item, "")
            if word.startswith(prefix):
                yield Completion(word, start_position=-len(prefix), display=word, display_meta=description)


def format_elapsed(seconds: float) -> str:
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes:02d}m {secs:02d}s"
    if minutes:
        return f"{minutes}m {secs:02d}s"
    return f"{secs}s"
from rich.console import Console
from rich.table import Table
from rich.markdown import Markdown
from rich.text import Text

from raven.core import (
    Agent,
    ConfigManager,
    CoreConfig,
    ToolRegistry,
    SessionManager,
    TargetManager,
    TaskQueue,
    CommandSystem
)
from raven.core.config import ConfigManager
from raven.backend import ChatBackend, BackendConfig, PRESETS
from raven.tools import build_registry
from raven.project_tools import ProjectTools
from raven.banner import print_banner
from raven.style import (
    PRIMARY_COLOR, TEXT_PRIMARY, TEXT_SECONDARY, TEXT_DIM, 
    BORDER_COLOR, HIGHLIGHT_COLOR,
    print_separator, display_user_message, display_ai_message
)
from raven.enhanced_ui import (
    AnimatedThinking, AnimatedToolCall, AnimatedResponse,
    StatusMessage, InputIndicator, ThinkingBlock
)
from raven.skill_loader import load_skills
from raven.skills_manager import (
    create_skill,
    delete_skill,
    duplicate_skill,
    find_skill,
    list_skills,
    validate_skill,
)

__version__ = "1.0.0-alpha"

console = Console()
PACKAGE_ROOT = Path(__file__).parent.parent
DEFAULT_SKILLS_ROOT = PACKAGE_ROOT / "skills"
DEFAULT_SKILLS = ("cmd", "raven-code", "osint-threat-intel")


class RavenCLI:
    """Main CLI class using Raven Core"""
    
    def __init__(self, skills_root=DEFAULT_SKILLS_ROOT, skill_names=(), skill_dirs=()):
        self.console = Console()
        self.config_manager = ConfigManager()
        self.config = self.config_manager.get()
        
        # Skill configuration
        self.skills_root = skills_root
        self.skill_names = skill_names
        self.skill_dirs = skill_dirs
        self.max_iterations = max(32, self.config.max_iterations)
        self.temperature = self.config.backend.temperature
        self.show_thinking = self.config.show_thinking
        self.loaded_skill_names = set(DEFAULT_SKILLS) | set(skill_names)  # Track loaded skills
        self.prompt_session = None
        
        # Initialize core systems
        self.tool_registry = ToolRegistry()
        self.session_manager = SessionManager()
        self.target_manager = TargetManager()
        self.task_queue = TaskQueue(max_workers=self.config.tasks.max_concurrent)
        self.command_system = CommandSystem()
        self.project_tools = ProjectTools(Path(self.config.workspace.path))
        
        # Register built-in commands
        self._register_commands()
        
        # Initialize tools
        self._initialize_tools()
        
        # Backend client
        self.backend = None
        self.agent = None
        self.system_prompt = ""
        
        self._running = False
    
    def _resolve_skills(self):
        """Turn --skill NAME and --skill-dir PATH options into a list of skill folders."""
        resolved = []
        requested_names = list(DEFAULT_SKILLS) + list(self.skill_names)
        for name in dict.fromkeys(requested_names):
            info = find_skill(self.skills_root, name)
            if not info:
                available = ", ".join(s.name for s in list_skills(self.skills_root)) or "(none found)"
                raise click.UsageError(f"No skill named '{name}' in {self.skills_root}. Available: {available}")
            resolved.append(info.path)
        resolved.extend(self.skill_dirs)
        if not resolved:
            raise click.UsageError("No default skills found in the skills directory.")
        return resolved
    
    def _register_commands(self):
        """Register built-in commands"""
        from raven.commands.builtin_commands_new import register_builtin_commands
        register_builtin_commands(
            self.command_system,
            self.session_manager,
            self.target_manager,
            self.task_queue,
            self.config_manager
        )
    
    def _initialize_tools(self):
        """Initialize tools from config"""
        from raven.core.tools import register_built_in_tools
        register_built_in_tools(self.tool_registry, self.config)
    
    def _initialize_backend(self, backend_name, model, base_url, api_key):
        """Initialize backend from config or CLI args"""
        # Get preset or use custom
        if backend_name in PRESETS:
            preset = PRESETS[backend_name]
            resolved_base_url = base_url or preset["base_url"]
            if not resolved_base_url:
                raise click.UsageError(f"--backend {backend_name} needs --base-url.")
            
            key_env = preset.get("api_key_env")
            if key_env:
                api_key = api_key or os.environ.get(key_env)
        else:
            resolved_base_url = base_url
            if not resolved_base_url:
                raise click.UsageError(f"--backend {backend_name} needs --base-url.")
        
        # Create backend config
        backend_config = BackendConfig(
            base_url=resolved_base_url,
            model=model,
            api_key=api_key,
            temperature=self.temperature,
            # HTML/CSS files can be larger than a chat answer. Leave enough
            # room for the complete JSON tool block so it can be executed.
            max_tokens=self.config.backend.max_tokens,
            timeout=self.config.backend.timeout
        )
        
        self.backend = ChatBackend(backend_config)
        
        # Load skills and create agent
        skill_paths = self._resolve_skills()
        self.system_prompt = load_skills(skill_paths, registry=self.tool_registry)
        
        # Create agent
        self.agent = Agent(
            config=self.config,
            tool_registry=self.tool_registry,
            backend_client=self.backend,
            max_iterations=self.max_iterations,
            show_thinking=self.show_thinking,
            skills_root=self.skills_root,
            skill_loader_callback=self.load_skill
        )
        
        # Override system prompt with loaded skills
        self.agent.messages[0].content = self.system_prompt
        self._loaded_skill_paths = skill_paths
        # Initialize agent with currently loaded skills
        self.agent.loaded_skills = set(DEFAULT_SKILLS) | set(self.skill_names)
    
    def load_skill(self, skill_name: str):
        """Dynamically load a skill and add it to the system prompt"""
        from raven.skills_manager import find_skill
        
        # Check if already loaded
        if skill_name in self.loaded_skill_names:
            return True, f"Skill '{skill_name}' already loaded"
        
        skill_info = find_skill(self.skills_root, skill_name)
        if not skill_info:
            return False, f"Skill '{skill_name}' not found"
        
        # Load the skill
        new_skill_prompt = load_skills([skill_info.path], registry=self.tool_registry)
        
        # Append to existing system prompt
        self.system_prompt += "\n\n" + new_skill_prompt
        
        # Update agent's system prompt
        self.agent.messages[0].content = self.system_prompt
        
        # Add to loaded skills tracking
        if not hasattr(self, '_loaded_skill_paths'):
            self._loaded_skill_paths = []
        self._loaded_skill_paths.append(skill_info.path)
        self.loaded_skill_names.add(skill_name)
        
        return True, f"Skill '{skill_name}' loaded successfully"

    def set_skill_enabled(self, skill_name: str, enabled: bool):
        """Persist a skill toggle and rebuild the active system prompt."""
        from raven.skills_manager import find_skill

        if skill_name in DEFAULT_SKILLS and not enabled:
            return False, f"Skill '{skill_name}' is a required default skill"

        if not find_skill(self.skills_root, skill_name):
            return False, f"Skill '{skill_name}' not found"

        enabled_skills = list(self.config.enabled_skills or self.skill_names)
        if enabled and skill_name not in enabled_skills:
            enabled_skills.append(skill_name)
        if not enabled:
            enabled_skills = [name for name in enabled_skills if name != skill_name]
        if not enabled_skills:
            return False, "At least one skill must remain enabled"

        self.config.enabled_skills = enabled_skills
        self.config_manager.save()
        self.skill_names = tuple(enabled_skills)
        skill_paths = self._resolve_skills()
        self.system_prompt = load_skills(skill_paths, registry=self.tool_registry)
        if self.agent:
            self.agent.messages[0].content = self.system_prompt
            self.agent.loaded_skills = set(enabled_skills)
        self.loaded_skill_names = set(DEFAULT_SKILLS) | set(enabled_skills)
        return True, f"Skill '{skill_name}' {'enabled' if enabled else 'disabled'}"

    def _available_skill_names(self):
        return [skill.name for skill in list_skills(self.skills_root)]

    def restore_session_context(self, session_id: str):
        """Load a saved session and restore its conversation in the agent."""
        session = self.session_manager.load(session_id)
        if not session:
            return None

        if self.agent:
            from raven.core.agent import Message

            restored = [Message(role="system", content=self.system_prompt)]
            for entry in session.entries:
                if entry.role in ("user", "assistant") and entry.content:
                    restored.append(Message(role=entry.role, content=entry.content))
            self.agent.messages = restored
        return session
    
    def start(self, backend_name, model, base_url, api_key):
        """Start the CLI"""
        self._running = True
        self._start_reminder_worker()
        
        # Initialize backend
        try:
            self._initialize_backend(backend_name, model, base_url, api_key)
        except Exception as e:
            self.console.print(f"[red]Failed to initialize backend: {e}[/red]")
            self.console.print("[yellow]Run /config to set up your backend[/yellow]")
            return
        
        # Print banner
        print_banner(self.console, __version__, "Raven CLI")
        
        # Create initial session
        self.session_manager.create("default")
        
        # Main loop with enhanced input system
        while self._running:
            try:
                # Compact agent-style prompt. The submitted line is already
                # echoed by the terminal, so do not print it again.
                if self.prompt_session is None and PromptSession is not None:
                    names = [(f"/{command.name}", command.description) for command in self.command_system.commands.values()]
                    names.extend((f"/skill {name}", "Toggle or load skill") for name in self._available_skill_names())
                    bindings = KeyBindings()

                    @bindings.add("/")
                    def _(event):
                        event.current_buffer.insert_text("/")
                        event.current_buffer.start_completion(select_first=False)

                    self.prompt_session = PromptSession(
                        completer=SlashCompleter(names),
                        complete_while_typing=True,
                        complete_style=CompleteStyle.MULTI_COLUMN,
                        key_bindings=bindings,
                        style=Style.from_dict({
                            "completion-menu": "bg:#0B1826 #B8C7D9",
                            "completion-menu.completion": "bg:#0B1826 #B8C7D9",
                            "completion-menu.completion.current": "bg:#1B4058 #FFFFFF",
                            "completion-menu.meta.completion": "bg:#0B1826 #6F899F",
                            "completion-menu.meta.completion.current": "bg:#1B4058 #D7E7F2",
                            "scrollbar.background": "bg:#0B1826",
                            "scrollbar.button": "bg:#22D3C5",
                        }),
                    )
                if self.prompt_session:
                    user_input = self.prompt_session.prompt("\n› ", reserve_space_for_menu=8)
                else:
                    user_input = self.console.input("\n› ")
                
                if not user_input.strip():
                    continue
                
                # Check for commands
                if user_input.startswith("/"):
                    self._handle_command(user_input)
                    continue
                
                self._handle_ai_input(user_input)
                
            except KeyboardInterrupt:
                self.console.print("\n[yellow]Interrupted. Type /quit to exit.[/yellow]")
            except EOFError:
                break

    def _start_reminder_worker(self):
        from raven.automation import AutomationStore

        store = AutomationStore()

        def worker():
            while self._running:
                try:
                    for item in store.due():
                        self.console.print(f"\n[bold #22D3C5]Raven reminder[/bold #22D3C5] {item.get('title', '')}")
                        if item.get("prompt") and item.get("prompt") != item.get("title"):
                            self.console.print(item["prompt"])
                except Exception:
                    pass
                time.sleep(15)

        threading.Thread(target=worker, name="raven-reminders", daemon=True).start()
    
    def _handle_command(self, user_input: str):
        """Handle slash commands"""
        parts = user_input.split(maxsplit=1)
        command_name = parts[0][1:]  # Remove /
        args = parts[1] if len(parts) > 1 else ""
        
        # Special commands
        if command_name in ("quit", "exit"):
            self._running = False
            return
        
        if command_name == "restart":
            self._restart()
            return
        
        # Execute command
        context = {
            "config_manager": self.config_manager,
            "console": self.console,
            "cli": self  # Pass CLI instance for skill loading
        }
        result = self.command_system.execute(command_name, args, context)
        self.console.print(result)
    
    def _handle_ai_input(self, user_input: str, cancel=None):
        """Handle regular AI input with enhanced UI and animations"""
        # Check for duplicate input
        if hasattr(self, '_last_input') and self._last_input == user_input:
            return
        self._last_input = user_input

        # Add to session
        self.session_manager.add_entry("user", user_input)
        
        # The input prompt already echoed the user's message. Printing it again
        # here made every prompt appear twice.
        print_separator(self.console)

        # Real-time thinking timer
        thinking_start = time.time()
        thinking_displayed = False
        thinking_live = None
        
        # Process with agent with real-time updates
        def callback(event_type, data):
            nonlocal thinking_displayed, thinking_live
            if event_type == "stream":
                if thinking_live is None:
                    thinking_live = self._display_thinking_with_timer("", thinking_start)
                thinking_displayed = True
            elif event_type == "thinking":
                if not thinking_displayed:
                    # Show thinking with real-time timer
                    thinking_displayed = True
                    thinking_live = self._display_thinking_with_timer(data, thinking_start)
                else:
                    # Update timer in the live display
                    if thinking_live:
                        self._update_thinking_timer(thinking_live, thinking_start)
            elif event_type == "tool_call":
                # Stop thinking display if active
                if thinking_live:
                    thinking_live.stop()
                    thinking_live = None
                # Compact tool status, similar to modern coding agents.
                self.console.print(f"[{PRIMARY_COLOR}]•[/{PRIMARY_COLOR}] {data.name}")
                if data.name == "web_search":
                    query = data.arguments.get("query", "")
                    self.console.print(f"[{TEXT_DIM}]query: {query}[/{TEXT_DIM}]")
            elif event_type == "tool_result":
                # Simple tool result display
                if "error" in data:
                    self.console.print(f"[{PRIMARY_COLOR}]error[/{PRIMARY_COLOR}] {data['error']}")
                elif "count" in data and "results" in data:
                    status = data.get("status", "ok")
                    self.console.print(f"[{TEXT_DIM}]{status}: {data.get('count', 0)} result(s) [{data.get('backend', 'tool')}][/{TEXT_DIM}]")
                    for item in data.get("results", [])[:3]:
                        title = item.get("title", "untitled") if isinstance(item, dict) else str(item)
                        url = item.get("href") or item.get("url") or "" if isinstance(item, dict) else ""
                        body = item.get("body") or item.get("snippet") or "" if isinstance(item, dict) else ""
                        self.console.print(f"  [{TEXT_SECONDARY}]{title}[/{TEXT_SECONDARY}] {url}")
                        if body:
                            self.console.print(f"  [{TEXT_DIM}]{body[:240]}[/{TEXT_DIM}]")
                elif "success" in data and data["success"]:
                    self.console.print(f"[{PRIMARY_COLOR}]done[/{PRIMARY_COLOR}]")
                elif "content" in data:
                    self.console.print(f"[{TEXT_DIM}]{str(data['content'])[:500]}[/{TEXT_DIM}]")
                else:
                    self.console.print(f"[{TEXT_DIM}]result received[/{TEXT_DIM}]")
        
        context = self.project_tools.context_for_query(user_input)
        try:
            response = self.agent.process(
                f"Project context: {context}\n\nUser request:\n{user_input}", callback
            )
        except Exception as exc:
            if thinking_live:
                thinking_live.stop()
            self.console.print(f"[{PRIMARY_COLOR}]error[/{PRIMARY_COLOR}] {type(exc).__name__}: {exc}")
            return
        
        # Stop thinking display if still active
        if thinking_live:
            thinking_live.stop()
        
        # Add response to session
        self.session_manager.add_entry("assistant", response)
        
        # Model output is text, not Rich markup. Rendering it as markup leaks
        # tokens such as [#A0A0B8] into the terminal when the model emits them.
        self.console.print(Text(response))
        print_separator(self.console)

    def _display_thinking_with_timer(self, content: str, start_time: float):
        """Display thinking with real-time timer."""
        from rich.live import Live
        from rich.text import Text
        import threading

        thinking_content = content[:200] + "..." if len(content) > 200 else content

        class TimedThinking:
            def __init__(self):
                self.console = outer_console
                self.running = True
                self.content = thinking_content
                self.live = Live(console=self.console, refresh_per_second=10)
                self.live.start()
                self.thread = threading.Thread(target=self._refresh, daemon=True)
                self.thread.start()

            def _refresh(self):
                while self.running:
                    elapsed = time.time() - start_time
                    preview = self.content[-240:].replace("\n", " ")
                    line = Text()
                    line.append("  thinking  ", style=PRIMARY_COLOR)
                    line.append(preview or "working", style=TEXT_SECONDARY)
                    line.append(f"  {format_elapsed(elapsed)}", style=TEXT_DIM)
                    self.live.update(line)
                    time.sleep(0.1)

            def update_content(self, content):
                self.content = (self.content + content)[-240:]

            def stop(self):
                if not self.running:
                    return
                self.running = False
                self.thread.join(timeout=0.3)
                self.live.stop()

        outer_console = self.console
        return TimedThinking()
    
    def _update_thinking_timer(self, live, start_time: float):
        """Update the thinking timer display."""
        if live:
            elapsed = time.time() - start_time
            # Rich Live automatically refreshes the display
    
    def _restart(self):
        """Restart the CLI"""
        self.console.print("[yellow]Restarting...[/yellow]")
        self._running = False


@click.group(invoke_without_command=True)
@click.pass_context
@click.option("--raven", "raven_mode", is_flag=True, hidden=True, help="Démarrer Raven en mode agent.")
def cli(ctx, raven_mode):
    """Raven — multi-backend, multi-skill OSINT/CTI agent."""
    if ctx.invoked_subcommand is None:
        # If no subcommand, invoke chat
        ctx.invoke(chat)


@cli.command()
@click.option("--backend", "backend_name", type=click.Choice(list(PRESETS.keys())), default=None, show_default=True, help="Quel serveur LLM utiliser.")
@click.option("--model", default=None, help="Nom du modèle comme connu par le backend.")
@click.option("--base-url", default=None, help="Remplacer l'URL de base par défaut (requis pour --backend custom).")
@click.option("--api-key", default=None, help="Clé API (remplace la variable d'environnement).")
@click.option("--api-key-env", default=None, help="Nom de la variable d'environnement pour la clé API.")
@click.option("--skills-root", type=click.Path(path_type=Path), default=DEFAULT_SKILLS_ROOT, show_default=True, help="Dossier contenant les sous-dossiers de skills.")
@click.option("--skill", "skill_names", multiple=True, help="Nom d'un skill (recherché dans --skills-root). Répétable pour combiner plusieurs skills.")
@click.option("--skill-dir", "skill_dirs", type=click.Path(exists=True, path_type=Path), multiple=True, help="Chemin direct vers un dossier de skill, contourne --skills-root. Répétable.")
@click.option("--workspace", type=click.Path(path_type=Path), default=None, help="Dossier dans lequel Raven peut créer et modifier les fichiers.")
@click.option("--configure", is_flag=True, help="Lancer l'assistant de configuration avant de démarrer.")
def chat(backend_name, model, base_url, api_key, api_key_env, skills_root, skill_names, skill_dirs, workspace, configure):
    """Démarrer une session de chat interactive avec l'agent."""
    # Handle configuration wizard
    if configure:
        from raven.setup_wizard import SetupWizard
        wizard = SetupWizard()
        wizard.run()
        return
    
    # Get config
    config_manager = ConfigManager()
    config = config_manager.get()
    
    if workspace:
        config.workspace.path = str(workspace.resolve())
        config_manager.save()
    
    # Handle api-key-env
    if api_key_env:
        api_key = os.environ.get(api_key_env, api_key)
    
    # Use config values if CLI args not provided
    backend_name = backend_name or config.backend.type
    model = model or config.backend.model
    base_url = base_url or config.backend.base_url
    api_key = api_key or config.backend.api_key
    
    # Override config with CLI args
    if backend_name or model or base_url or api_key:
        if backend_name:
            config_manager.config.backend.type = backend_name
        if model:
            config_manager.config.backend.model = model
        if base_url:
            config_manager.config.backend.base_url = base_url
        if api_key:
            config_manager.config.backend.api_key = api_key
        config_manager.save()
    
    # Set default skills if none specified
    if not skill_names and not skill_dirs:
        skill_names = tuple(config.enabled_skills or ("osint-threat-intel", "raven-code"))
        if not config.enabled_skills:
            config.enabled_skills = list(skill_names)
            config_manager.save()
    
    # Start CLI
    raven_cli = RavenCLI(
        skills_root=skills_root,
        skill_names=skill_names,
        skill_dirs=skill_dirs
    )
    raven_cli.start(backend_name, model, base_url, api_key)


@cli.command()
@click.argument("shell", type=click.Choice(["bash", "zsh", "fish"]))
def completion(shell):
    """Affiche la commande à ajouter à ton shell pour l'auto-complétion des commandes/options."""
    prog = "raven"
    var = "_RAVEN_COMPLETE"
    if shell == "fish":
        cmd = f"{var}=fish_source {prog} | source"
        rc = "~/.config/fish/config.fish"
    else:
        cmd = f'eval "$({var}={shell}_source {prog})"'
        rc = f"~/.{shell}rc"
    console.print(f"Ajoute cette ligne à la fin de [bold]{rc}[/bold] puis relance ton shell :\n")
    console.print(f"  [bold green]{cmd}[/bold green]\n")
    console.print("Ensuite, taper `raven ` puis Tab complète les sous-commandes et options.")


@cli.command()
def config():
    """Open configuration wizard"""
    from raven.setup_wizard import SetupWizard
    wizard = SetupWizard()
    wizard.run()


@cli.group()
def skills():
    """Manage skills: list, create, fork, edit, validate, delete."""
    pass


@skills.command("list")
@click.option("--skills-root", type=click.Path(path_type=Path), default=DEFAULT_SKILLS_ROOT, show_default=True)
def skills_list(skills_root):
    """List all skills available under --skills-root."""
    found = list_skills(skills_root)
    if not found:
        console.print(f"[yellow]No skills found in {skills_root}[/yellow]")
        return
    table = Table(title=f"Skills in {skills_root}")
    table.add_column("Name", style="bold cyan")
    table.add_column("Description")
    for info in found:
        table.add_row(info.name, info.description)
    console.print(table)


@skills.command("create")
@click.argument("name")
@click.option("--description", required=True, help="When Claude/the model should reach for this skill — be specific, this drives triggering.")
@click.option("--skills-root", type=click.Path(path_type=Path), default=DEFAULT_SKILLS_ROOT, show_default=True)
def skills_create(name, description, skills_root):
    """Scaffold a new blank custom skill named NAME."""
    try:
        path = create_skill(skills_root, name, description)
    except FileExistsError as e:
        raise click.UsageError(str(e))
    console.print(f"[green]Created[/green] {path}\nEdit {path / 'SKILL.md'} to fill it in, or run `raven skills edit {name}`.")


@skills.command("fork")
@click.argument("source_name")
@click.argument("new_name")
@click.option("--skills-root", type=click.Path(path_type=Path), default=DEFAULT_SKILLS_ROOT, show_default=True)
def skills_fork(source_name, new_name, skills_root):
    """Duplicate an existing skill (e.g. the bundled osint-threat-intel) as a starting point for your own."""
    try:
        path = duplicate_skill(skills_root, source_name, new_name)
    except (FileNotFoundError, FileExistsError) as e:
        raise click.UsageError(str(e))
    console.print(f"[green]Forked[/green] '{source_name}' -> {path}")


@skills.command("edit")
@click.argument("name")
@click.option("--skills-root", type=click.Path(path_type=Path), default=DEFAULT_SKILLS_ROOT, show_default=True)
def skills_edit(name, skills_root):
    """Open a skill's SKILL.md in $EDITOR."""
    info = find_skill(skills_root, name)
    if not info:
        raise click.UsageError(f"No skill named '{name}' in {skills_root}")
    editor = os.environ.get("EDITOR", "nano")
    subprocess.call([editor, str(info.path / "SKILL.md")])


@skills.command("validate")
@click.argument("name")
@click.option("--skills-root", type=click.Path(path_type=Path), default=DEFAULT_SKILLS_ROOT, show_default=True)
def skills_validate(name, skills_root):
    """Check a skill's SKILL.md has the fields needed for reliable triggering."""
    info = find_skill(skills_root, name)
    if not info:
        raise click.UsageError(f"No skill named '{name}' in {skills_root}")
    problems = validate_skill(info.path)
    if problems:
        console.print(f"[red]Invalid:[/red] {name}")
        for p in problems:
            console.print(f"  - {p}")
    else:
        console.print(f"[green]Valid:[/green] {name}")


@skills.command("delete")
@click.argument("name")
@click.option("--skills-root", type=click.Path(path_type=Path), default=DEFAULT_SKILLS_ROOT, show_default=True)
@click.confirmation_option(prompt="This permanently deletes the skill folder. Continue?")
def skills_delete(name, skills_root):
    """Delete a custom skill."""
    try:
        delete_skill(skills_root, name)
    except FileNotFoundError as e:
        raise click.UsageError(str(e))
    console.print(f"[green]Deleted[/green] {name}")


if __name__ == "__main__":
    # If called directly without subcommand, default to chat
    if len(sys.argv) == 1:
        chat()
    else:
        cli()
