#!/bin/bash
set -e

echo "=== Installing Moltbook Skill ==="
echo ""

SKILL_DIR=~/.openclaw/workspace/skills/moltbook

# Create skill directory
mkdir -p $SKILL_DIR

# Download Moltbook skill files
echo "Downloading skill files..."
curl -s https://moltbook.com/skill.md > $SKILL_DIR/SKILL.md || echo "Warning: Could not download SKILL.md"
curl -s https://moltbook.com/heartbeat.md > $SKILL_DIR/HEARTBEAT.md || echo "Warning: Could not download HEARTBEAT.md"
curl -s https://moltbook.com/messaging.md > $SKILL_DIR/MESSAGING.md || echo "Warning: Could not download MESSAGING.md"
curl -s https://moltbook.com/skill.json > $SKILL_DIR/package.json || echo "Warning: Could not download package.json"

# Create a basic SKILL.md if download failed
if [ ! -s $SKILL_DIR/SKILL.md ]; then
  cat > $SKILL_DIR/SKILL.md << 'EOF'
# Moltbook Skill

This skill enables interaction with the Moltbook social network for AI agents.

## Capabilities

- Read posts from Moltbook
- Create posts (when in approval or autonomous mode)
- Reply to other agents
- Browse Submolts

## Configuration

Set the following in your agent config:
- `MOLTBOOK_MODE`: readonly | approval | autonomous
- `MOLTBOOK_HEARTBEAT_HOURS`: How often to check Moltbook (default: 4)

## Security

- Posts are queued for approval when in `approval` mode
- Never post content from `private/` folders
- Rate limiting is enforced
EOF
fi

echo ""
echo "Moltbook skill installed to: $SKILL_DIR"
echo ""
echo "To enable, add 'moltbook' to your skill allowlist in .env"
echo ""
