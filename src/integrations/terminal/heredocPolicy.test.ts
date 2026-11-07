import { strict as assert } from "node:assert"
import { detectHeredocFileRedirection, findTopLevelHeredocs, isMultilineHeredocCommand } from "./heredocPolicy.js"

describe("heredoc policy", () => {
	it("detects file redirections before and after heredoc operators", () => {
		for (const command of [
			"cat > game.c <<'EOF'\ncode\nEOF",
			"cat<<'EOF'>\"my file.txt\"\ncode\nEOF",
			"cat << EOF >> file.txt\ncode\nEOF",
			"cat << EOF | cat > output.txt\ncode\nEOF",
			"cat << EOF | sudo tee output.txt\ncode\nEOF",
			"sudo tee -a output.txt <<'EOF'\ncode\nEOF",
			"cat << EOF\ncode\nEOF > output.txt",
		]) {
			assert.equal(detectHeredocFileRedirection(command).isHeredocFileWrite, true, command)
		}
	})

	it("returns affected paths and actionable structured-tool guidance", () => {
		const result = detectHeredocFileRedirection("cat << EOF > 'src/my file.ts'\ncontents\nEOF")
		assert.deepEqual(result.targetFiles, ["src/my file.ts"])
		assert.match(result.reason, /write_to_file/)
	})

	it("detects heredoc writes nested in shell command strings", () => {
		const command = `bash -c 'cat <<EOF > generated.txt\ncontents\nEOF'`
		assert.equal(detectHeredocFileRedirection(command).isHeredocFileWrite, true)
		assert.equal(detectHeredocFileRedirection(`printf '%s' '$(cat <<EOF > literal.txt)'`).isHeredocFileWrite, false)
		assert.equal(
			detectHeredocFileRedirection(`printf '%s' "$(cat <<EOF > generated.txt\ncontents\nEOF)"`).isHeredocFileWrite,
			true,
		)
	})

	it("ignores shifts, quoted operators, here strings, and non-file heredocs", () => {
		for (const command of [
			"echo $((8 << 2))",
			"echo 'cat <<EOF > file'",
			"python -c 'print(1)' <<< input",
			"cat << EOF\ncontents\nEOF",
			"cat << EOF | tee /dev/null\ncontents\nEOF",
			"printf '>' << EOF\ncontents\nEOF",
			"cat << EOF >&2\ncontents\nEOF",
		]) {
			assert.equal(detectHeredocFileRedirection(command).isHeredocFileWrite, false, command)
		}
	})

	it("tracks tab-stripped and chained delimiters and identifies multiline execution", () => {
		const command = "cat <<-A <<'B'\n\tfirst\n\tA\nsecond\nB"
		assert.deepEqual(
			findTopLevelHeredocs(command).map(({ delimiter }) => delimiter),
			["A", "B"],
		)
		assert.equal(isMultilineHeredocCommand(command), true)
		assert.equal(isMultilineHeredocCommand("cat <<EOF"), false)
	})
})
