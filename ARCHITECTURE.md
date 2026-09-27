# Raven Architecture v1.0.0-alpha

## Overview

Raven v1.0.0-alpha introduces a completely refactored architecture with modular systems for command handling, session management, target tracking, and safe command execution.

## Directory Structure

```
raven/
├── __init__.py
├── agent.py                 # Core AI agent loop
├── backend.py               # LLM backend abstraction
├── banner.py                # ASCII art banner
├── browser_tools.py         # Real browser integration
├── cli.py                   # Main CLI entry point
├── command_executor.py      # Safe shell command execution
├── config.py                # Configuration management
├── db_tools.py              # Database integration
├── file_tools.py            # File system operations
├── skill_loader.py          # Skill system integration
├── skills_manager.py        # Skill CRUD operations
├── style.py                 # UI styling constants
└── tools.py                 # Tool registry and execution

# New modular systems
├── commands/                # Command system
│   ├── __init__.py
│   ├── command_registry.py  # Command registration
│   ├── command_handler.py   # Command parsing and execution
│   ├── builtin_commands.py  # Built-in command implementations
│   └── completion.py        # Tab completion system
├── session_manager/         # Session tracking
│   ├── __init__.py
│   └── session_manager.py  # Session CRUD and history
└── target_manager/         # Investigation targets
    ├── __init__.py
    └── target_manager.py    # Target management with auto-association

skills/
├── osint-threat-intel/      # Original OSINT skill
│   ├── SKILL.md
│   └── references/
└── cmd/                      # New command execution skill
    ├── SKILL.md
    └── references/
        └── command-examples.md
```

## Core Systems

### 1. Command System (`raven/commands/`)

**Purpose**: Provide a extensible command system with `/` syntax for interactive control.

**Components**:
- **CommandRegistry**: Central registry for all commands with metadata
- **CommandHandler**: Parses user input and executes commands
- **CommandCompleter**: Provides Tab completion for commands
- **Builtin Commands**: Pre-built commands for common operations

**Key Features**:
- Extensible registration system
- Automatic help generation
- Tab completion support
- Command aliases
- Rich error handling

**Usage Example**:
```python
registry = CommandRegistry(console)
registry.register(
    name="mycommand",
    description="My custom command",
    handler=my_handler,
    args_help="[arg1]",
    examples=["/mycommand value"]
)
```

### 2. Session Manager (`raven/session_manager/`)

**Purpose**: Track conversation history with persistence and search capabilities.

**Components**:
- **Session**: Data class representing a conversation session
- **SessionEntry**: Individual message in a session
- **SessionManager**: CRUD operations for sessions

**Key Features**:
- Automatic session creation
- JSON persistence
- Export to Markdown
- Full-text search
- Session metadata tracking

**Storage Structure**:
```
.raven_sessions/
├── 20240101_120000.json
├── 20240102_143000.json
└── exports/
    └── 20240101_120000_export.md
```

### 3. Target Manager (`raven/target_manager/`)

**Purpose**: Manage investigation targets with automatic identifier association.

**Components**:
- **TargetInfo**: Data class for target metadata
- **TargetManager**: CRUD operations for targets

**Key Features**:
- Automatic identifier association
- Structured folder organization
- Cross-referencing between targets
- Research tracking per target
- Intelligent name extraction

**Target Structure**:
```
targets/
├── mathieu/
│   ├── target_info.yaml      # Metadata and identifiers
│   ├── research/             # Investigation findings
│   ├── evidence/             # Collected evidence
│   └── reports/              # Generated reports
```

**Auto-Association Logic**:
```python
# From email "arigato@yopmail.com" → creates target "Arigato"
# From phone "+33612345678" → asks for target name
# From username "mathieu_hacker" → creates target "Mathieu Hacker"
```

### 4. Command Executor (`raven/command_executor.py`)

**Purpose**: Safe shell command execution with mandatory user confirmation.

**Components**:
- **CommandExecutor**: Main execution class with security checks

**Key Features**:
- Mandatory user confirmation
- Risk assessment (none/low/medium/high)
- Command explanation
- Security warnings
- Timeout protection
- Comprehensive error handling

**Risk Assessment Algorithm**:
```python
def _assess_risk(command):
    # High risk: rm -rf, format, diskpart, etc.
    # Medium risk: file modifications, package installs
    # Low risk: information gathering, safe operations
    # None: display commands only
```

## Integration Points

### CLI Integration (`raven/cli.py`)

The main CLI now integrates all new systems:

```python
# Initialize systems
command_registry = CommandRegistry(console)
session_manager = SessionManager(console=console)
target_manager = TargetManager(console=console)
command_handler = CommandHandler(command_registry, console)

# Register built-in commands
register_builtin_commands(command_registry, session_manager, target_manager)

# Enable completion
command_completer = CommandCompleter(command_handler, console)
command_completer.enable()

# Main loop with command detection
while True:
    user_input = console.input("› ")
    
    # Check for commands first
    if command_handler.execute(user_input):
        continue
    
    # Regular AI interaction
    session_manager.add_entry("user", user_input)
    answer = session.ask(user_input)
    session_manager.add_entry("assistant", answer)
```

### Tool Integration (`raven/tools.py`)

New tools are automatically registered with the AI:

```python
# Command execution
registry["execute_command"] = {
    "fn": command_executor.execute_command,
    "description": "Execute shell command with confirmation"
}

# Target management
registry["target_create"] = {
    "fn": target_create,
    "description": "Create investigation target"
}
registry["target_auto_associate"] = {
    "fn": target_auto_associate,
    "description": "Auto-associate identifier with target"
}
# ... more target tools
```

### Skill Integration

The `cmd` skill provides AI guidance for command execution:

**Scope**: Execute shell commands with explicit user confirmation
**Workflow**: Identify → Formulate → Explain → Confirm → Execute → Report
**Safety**: Mandatory confirmation, risk assessment, clear warnings

## Data Flow

### Command Execution Flow

```
User Input → CommandHandler → CommandRegistry → Command Handler
                                                    ↓
                                            User Confirmation
                                                    ↓
                                            CommandExecutor
                                                    ↓
                                            Result Display
```

### Target Association Flow

```
AI Investigation → Identifier Found → target_auto_associate()
                                        ↓
                                Find Existing Target?
                                ├─ Yes → Add to existing
                                └─ No  → Create new target
                                        ↓
                                Save Research to target/research/
                                        ↓
                                Update target_info.yaml
```

### Session Tracking Flow

```
User Message → session_manager.add_entry("user", message)
                    ↓
            AI Processing
                    ↓
AI Response → session_manager.add_entry("assistant", response)
                    ↓
            Auto-save to .raven_sessions/
```

## Security Architecture

### Command Execution Security

1. **Confirmation Gate**: Every command requires explicit user approval
2. **Risk Assessment**: Commands are analyzed before execution
3. **Clear Warnings**: High-risk commands show explicit warnings
4. **Audit Trail**: All commands logged in session history
5. **Timeout Protection**: Commands have execution time limits

### Target Management Privacy

1. **Local Storage**: All data stored locally
2. **No Cloud Upload**: No external data transmission
3. **User Control**: User controls what gets stored
4. **Structured Access**: Organized folder structure

### Session Data Protection

1. **Local Persistence**: Sessions stored in `.raven_sessions/`
2. **Export Control**: User initiates all exports
3. **Search Scope**: User controls search scope
4. **Deletion Control**: Explicit confirmation for deletion

## Extension Points

### Adding New Commands

1. Create handler function in `builtin_commands.py`
2. Register in `register_builtin_commands()`
3. Update documentation
4. Test with various inputs

### Adding New Target Operations

1. Add method to `TargetManager` class
2. Create corresponding tool wrapper in `tools.py`
3. Update AI skill documentation
4. Test with real investigations

### Extending Command Completion

1. Modify `CommandCompleter._get_completions()`
2. Add context-aware logic
3. Test with various input patterns
4. Update documentation

## Performance Considerations

### Session Management

- Sessions are lazy-loaded when needed
- Search uses in-memory indexing for speed
- Export operations are batched

### Target Management

- Target info is cached in memory
- File operations use efficient I/O
- Auto-association uses fast lookups

### Command System

- Command registry is pre-built at startup
- Completion uses efficient prefix matching
- Command parsing is optimized for speed

## Testing Strategy

### Unit Testing

- Test each component in isolation
- Mock external dependencies
- Test edge cases and error conditions

### Integration Testing

- Test system interactions
- Test data flow between components
- Test with real user scenarios

### Security Testing

- Test command execution safety
- Test risk assessment accuracy
- Test confirmation gate effectiveness

## Future Enhancements

### Planned Features

1. **Target Relationship Graph**: Visualize connections between targets
2. **Automated Reporting**: Generate investigation reports
3. **Advanced Search**: Full-text search across all data
4. **Collaboration**: Share targets and sessions
5. **External Integration**: Connect with OSINT tools

### Architecture Improvements

1. **Plugin System**: Load external command modules
2. **Async Operations**: Improve performance with async I/O
3. **Database Backend**: Optional database for large datasets
4. **API Layer**: REST API for remote access

## Migration Guide

### From v0.2.0 to v1.0.0-alpha

1. **No Breaking Changes**: Existing functionality preserved
2. **New Directories**: Create `commands/`, `session_manager/`, `target_manager/`
3. **New Skill**: Add `skills/cmd/` directory
4. **Configuration**: Optional new settings in `settings.yaml`
5. **Data Migration**: Existing data works without changes

### Backward Compatibility

- All existing commands work unchanged
- Skills system unchanged
- Configuration format backward compatible
- Existing sessions and targets preserved

## Conclusion

The v1.0.0-alpha architecture provides a solid foundation for advanced investigation capabilities while maintaining the simplicity and security of the original Raven design. The modular structure allows for easy extension and maintenance.

The new systems integrate seamlessly with the existing codebase and provide powerful new capabilities without breaking existing functionality.
