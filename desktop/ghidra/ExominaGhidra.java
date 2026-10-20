// GhidraMCP 2.0 core over an Exomina-owned pipe. No listening socket.
// @category Exomina
// @importpackage com.lauriewired.ghidramcp.core
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.CommentType;
import com.lauriewired.ghidramcp.core.GhidraAnalysisService;
import com.google.gson.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.function.Supplier;

public class ExominaGhidra extends GhidraScript {
    private final Gson json = new Gson();
    private String prefix;
    private JsonObject args;
    private GhidraAnalysisService core;
    private String text(String key) { return args.has(key) && !args.get(key).isJsonNull() ? args.get(key).getAsString() : null; }
    private int number(String key, int fallback) { return args.has(key) ? args.get(key).getAsInt() : fallback; }
    private void reply(Object value) { System.out.println(prefix + json.toJson(value)); System.out.flush(); }
    private Object query(String operation) {
        int offset = number("offset", 0), limit = number("limit", 100);
        return switch(operation) {
            case "program_info" -> core.getProgramInfo(currentProgram);
            case "functions" -> core.listFunctions(currentProgram, text("filter"), offset, limit);
            case "classes" -> core.listClasses(currentProgram, offset, limit);
            case "namespaces" -> core.listNamespaces(currentProgram, offset, limit);
            case "segments" -> core.listSegments(currentProgram, offset, limit);
            case "imports" -> core.listImports(currentProgram, offset, limit);
            case "exports" -> core.listExports(currentProgram, offset, limit);
            case "data" -> core.listDefinedData(currentProgram, offset, limit);
            case "strings" -> core.listStrings(currentProgram, text("filter"), offset, limit);
            case "function" -> core.getFunction(currentProgram, text("address"));
            case "decompile" -> core.decompileByAddress(currentProgram, text("address"), monitor);
            case "disassemble" -> core.disassemble(currentProgram, text("address"), offset, limit);
            case "xrefs_to" -> core.getXrefsTo(currentProgram, text("address"), offset, limit);
            case "xrefs_from" -> core.getXrefsFrom(currentProgram, text("address"), offset, limit);
            case "function_xrefs" -> core.getFunctionXrefs(currentProgram, null, text("address"), offset, limit);
            case "function_calls" -> core.getFunctionCalls(currentProgram, text("address"), text("direction"), offset, limit);
            case "read_memory" -> core.readMemory(currentProgram, text("address"), number("length", 64));
            default -> throw new IllegalArgumentException("Unsupported read operation");
        };
    }
    private Object edit(String operation) {
        return switch(operation) {
            case "rename_function" -> core.renameFunctionByAddress(currentProgram, text("address"), text("new_name"));
            case "rename_data" -> core.renameData(currentProgram, text("address"), text("new_name"));
            case "rename_variable" -> core.renameVariable(currentProgram, null, text("address"), text("old_name"), text("new_name"), monitor);
            case "set_comment" -> core.setComment(currentProgram, text("address"), text("comment"), "disassembly".equals(text("view")) ? CommentType.EOL : CommentType.PRE);
            case "set_prototype" -> core.setFunctionPrototype(currentProgram, text("address"), text("prototype"), null, monitor);
            case "set_variable_type" -> core.setLocalVariableType(currentProgram, text("address"), text("variable_name"), text("new_type"), monitor);
            default -> throw new IllegalArgumentException("Unsupported edit operation");
        };
    }
    @Override public void run() throws Exception {
        String nonce = System.getenv("EXOMINA_GHIDRA_NONCE");
        if (nonce == null || nonce.length() != 64 || currentProgram == null) throw new IOException("Missing owned session");
        prefix = "EXOMINA_GHIDRA_" + nonce + ":";
        core = new GhidraAnalysisService(new GhidraAnalysisService.WriteExecutor() {
            public <T> T execute(Supplier<T> action) { return action.get(); }
        });
        // GhidraScript begins a surrounding transaction. Close it so each core
        // operation can commit and checkpoints/project saves can acquire a lock.
        end(true);
        currentProgram.save("Exomina initial analysis", monitor);
        String executableSha = currentProgram.getExecutableSHA256();
        reply(Map.of("id", 0, "result", core.getProgramInfo(currentProgram), "executableSha256", executableSha == null ? "" : executableSha));
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = input.readLine()) != null && !monitor.isCancelled()) {
            if (line.length() > 64000) throw new IOException("Request exceeds limit");
            JsonObject request = JsonParser.parseString(line).getAsJsonObject();
            if (!nonce.equals(request.get("nonce").getAsString())) throw new IOException("Wrong session");
            int id = request.get("id").getAsInt();
            String operation = request.get("operation").getAsString();
            if ("close".equals(operation)) { currentProgram.save("Exomina project saved", monitor); reply(Map.of("id", id, "result", Map.of("saved", true))); break; }
            try {
                args = request.getAsJsonObject("arguments");
                Object result;
                if (request.has("edit") && request.get("edit").getAsBoolean()) {
                    // A packed Ghidra database is a recoverable checkpoint before every change.
                    File checkpoints = new File(System.getenv("EXOMINA_GHIDRA_CHECKPOINTS"));
                    File checkpoint = new File(checkpoints, UUID.randomUUID() + ".gzf");
                    currentProgram.saveToPackedFile(checkpoint, monitor);
                    result = edit(operation);
                    currentProgram.save("Approved Exomina project edit", monitor);
                    reply(Map.of("id", id, "result", result, "checkpoint", checkpoint.getName()));
                } else { result = query(operation); reply(Map.of("id", id, "result", result)); }
            } catch (Exception failure) { reply(Map.of("id", id, "error", failure.getMessage() == null ? failure.getClass().getName() : failure.getMessage())); }
        }
    }
}
