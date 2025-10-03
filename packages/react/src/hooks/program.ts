// TODO: Replace any with inferred types.

"use client";

import {
  useMutation,
  type UseMutationOptions,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type { Address, Instruction } from "gill";

import { GILL_HOOK_CLIENT_KEY } from "../const.js";

type InstructionBuilder<TInput = any> = (input: TInput, config?: { programAddress?: Address }) => Instruction;

type AccountFetcher<TData = any> = (rpc: any, address: Address, config?: any) => Promise<TData>;

type Signer = any;
type SignerOrSigners = Signer | Signer[] | null;
type CommitmentLevel = "confirmed" | "finalized";

type SignAndSendFn = (
  instruction: Instruction,
  signers?: SignerOrSigners,
  options?: { commitment?: CommitmentLevel },
) => Promise<string>;

type ProgramHookConfig<
  TInstructions extends Record<string, InstructionBuilder<any>>,
  TAccounts extends Record<string, AccountFetcher<any>>,
> = {
  accounts: TAccounts;
  commitment?: CommitmentLevel | null;
  instructions: TInstructions;
  programAddress?: Address;
  /** Time to wait after transaction confirmation before refetching (default: 500ms) */
  refetchDelay?: number;
  rpc?: any;
  signAndSend: SignAndSendFn;
};

type UseProgramMutationInput<
  TInstructions extends Record<string, InstructionBuilder<any>>,
  TAccounts extends Record<string, AccountFetcher<any>>,
  TInstructionName extends keyof TInstructions,
> = Omit<
  UseMutationOptions<
    string,
    Error,
    Parameters<TInstructions[TInstructionName]>[0] & {
      commitment?: CommitmentLevel | null;
      signer?: SignerOrSigners;
    }
  >,
  "mutationFn"
> & {
  accounts?: Record<string, any> & {
    [K in keyof TAccounts]?: Parameters<TAccounts[K]>[0];
  };
  commitment?: CommitmentLevel | null;
  defaultSigners?: SignerOrSigners;
  instruction: TInstructionName;
};

type UseProgramQueryInput<
  TAccounts extends Record<string, AccountFetcher<any>>,
  TAccountName extends keyof TAccounts,
> = Omit<UseQueryOptions<Awaited<ReturnType<TAccounts[TAccountName]>>, Error>, "queryFn" | "queryKey"> & {
  account: TAccountName;
  address: Address;
  rpc: Parameters<TAccounts[TAccountName]>[0];
};

async function waitForConfirmation(rpc: any, signature: string, commitment: CommitmentLevel): Promise<void> {
  if (!rpc || !rpc.getSignatureStatuses) {
    console.warn("[createProgramHook] RPC client not available, skipping confirmation wait");
    return;
  }

  const maxRetries = 15;
  const initialDelay = commitment === "finalized" ? 2000 : 100;
  const maxDelay = 2000; 
  let retryCount = 0;
  let delay = initialDelay;

  console.log(`[createProgramHook] Waiting for ${commitment} confirmation of ${signature}...`);

  while (retryCount < maxRetries) {
    try {
      const response = await rpc.getSignatureStatuses([signature]).send();
      const status = response.value?.[0];

      if (status?.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      }

      if (status?.confirmationStatus) {
        const currentLevel = status.confirmationStatus;
        console.log(`[createProgramHook] Current confirmation level: ${currentLevel}`);

        if (currentLevel === commitment || (commitment === "confirmed" && currentLevel === "finalized")) {
          console.log(`[createProgramHook] Transaction reached ${commitment} confirmation`);
          return;
        }
      } else if (status === null) {
        console.log(`[createProgramHook] Transaction not found yet (attempt ${retryCount + 1}/${maxRetries})`);
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.2, maxDelay);
      retryCount++;
    } catch (error) {
      console.error("[createProgramHook] Error checking transaction status:", error);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.2, maxDelay);
      retryCount++;
      if (error instanceof Error && error.message.includes("Transaction failed")) {
        throw error;
      }
    }
  }
}

export function createProgramHook<
  TInstructions extends Record<string, InstructionBuilder<any>>,
  TAccounts extends Record<string, AccountFetcher<any>>,
>(config: ProgramHookConfig<TInstructions, TAccounts>) {
  const defaultCommitment = config.commitment === undefined ? "confirmed" : config.commitment;

  function useProgramMutation<TInstructionName extends keyof TInstructions>(
    input: UseProgramMutationInput<TInstructions, TAccounts, TInstructionName>,
  ) {
    const queryClient = useQueryClient();
    const { instruction, accounts, defaultSigners, commitment: mutationCommitment, ...options } = input;
    const instructionFn = config.instructions[instruction];

    return useMutation({
      ...options,
      mutationFn: async (
        instructionInput: Parameters<TInstructions[TInstructionName]>[0] & {
          commitment?: CommitmentLevel;
          signer?: SignerOrSigners;
        },
      ) => {
        if (!instructionInput) {
          throw new Error("Instruction input is required");
        }
        const { signer: inputSigner, commitment: inputCommitment, ...instructionParams } = instructionInput;
        const signerToUse = inputSigner !== undefined ? inputSigner : defaultSigners;
        const commitmentToUse = inputCommitment ?? mutationCommitment ?? defaultCommitment;
        const finalInput = { ...instructionParams, ...(accounts || {}) };

        const instruction = instructionFn(finalInput, {
          programAddress: config.programAddress,
        });

        // Get affected account addresses for query invalidation
        const affectedAddresses = instruction.accounts?.map((account) => account.address) || [];

        console.log("[createProgramHook] Affected addresses:", affectedAddresses);

        // Cancel any outgoing refetches for affected accounts
        await Promise.all(
          affectedAddresses.map((address: Address) =>
            queryClient.cancelQueries({
              predicate: (query) => {
                const queryKey = query.queryKey as string[];
                return queryKey.includes(address);
              },
              queryKey: [GILL_HOOK_CLIENT_KEY, "account"],
            }),
          ),
        );

        console.log("[createProgramHook] Sending transaction with signers:", signerToUse ? signerToUse : "none");
        const signature = await config.signAndSend(
          instruction,
          signerToUse,
          commitmentToUse ? { commitment: commitmentToUse } : undefined,
        );
        console.log("[createProgramHook] Transaction sent:", signature);

        console.log("commitmentToUse:", commitmentToUse, config.rpc);
        if (commitmentToUse && config.rpc) {
          console.log("[createProgramHook] waiting for confirmation");
          await waitForConfirmation(config.rpc, signature, commitmentToUse);
          console.log("[createProgramHook] confirmation complete");
        }

        console.log("[createProgramHook] Refetching queries...");
        await Promise.all(
          affectedAddresses.map(async (address: Address) => {
            const result = await queryClient.refetchQueries({
              predicate: (query) => {
                const queryKey = query.queryKey as string[];
                const matches = queryKey.includes(address);
                if (matches) {
                  console.log("[createProgramHook] Refetching query:", queryKey);
                }
                return matches;
              },
              queryKey: [GILL_HOOK_CLIENT_KEY, "account"],
              type: "active",
            });
            console.log("[createProgramHook] Refetch result for", address, ":", result);
            return result;
          }),
        );

        console.log("[createProgramHook] Refetch complete");

        return signature;
      },
    });
  }

  function useProgramQuery<TAccountName extends keyof TAccounts>(input: UseProgramQueryInput<TAccounts, TAccountName>) {
    const { account, address, rpc, ...options } = input;
    const accountFetcher = config.accounts[account];

    return useQuery({
      ...options,
      enabled: options.enabled !== false && !!address && !!rpc,
      queryFn: async () => {
        console.log("[useProgramQuery] Fetching account:", account, address);
        const data = await accountFetcher(rpc, address);
        console.log("[useProgramQuery] Fetched data:", data);
        return data;
      },
      queryKey: [GILL_HOOK_CLIENT_KEY, "account", account, address],
      staleTime: options.staleTime ?? 1000,
    });
  }

  return {
    useProgramMutation,
    useProgramQuery,
  };
}
